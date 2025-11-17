/**
 * OVMS Smart Charging Scheduler
 *
 * VERSION: 3.5.0
 * BUILD: Ready-by scheduling with passive ticker-based monitoring
 *
 * FEATURES:
 * - Ready-by time scheduling (reach target SOC by departure time)
 * - SOH-aware battery capacity calculations
 * - Cost estimates with cheap/standard rates (Intelligent Octopus Go)
 * - Automatic schedule calculation on plug-in detection
 * - Passive ticker-based monitoring (no destructive event subscriptions)
 *
 * ES5.1/DUKTAPE COMPATIBLE:
 * - Uses var only (no let/const)
 * - No arrow functions
 * - No template literals
 * - No modern array methods
 *
 * USAGE (app-friendly format):
 * script eval charging.setTarget(80)
 * script eval charging.setReadyBy(7,30)
 * script eval charging.setWindow(23,30,5,30)
 * script eval charging.setRates(0.07,0.292)
 * script eval charging.setCharger(1.8)
 * script eval charging.status()
 * script eval charging.start()
 * script eval charging.stop()
 */

// ============================================================================
// VERSION & MODULE INFO
// ============================================================================

var VERSION = "3.5.1";

if (typeof exports === "undefined") {
    var exports = {};
}

print("\n");
print("OVMS Smart Charging v" + VERSION + "\n");
print("==================================================\n");

// ============================================================================
// UTILITIES
// ============================================================================

function pad(n) {
    return (n < 10) ? "0" + n : String(n);
}

function timestamp() {
    var d = new Date();
    return pad(d.getHours()) + ":" + pad(d.getMinutes());
}

function formatTime(hour, minute) {
    return pad(hour) + ":" + pad(minute);
}

// ============================================================================
// CONFIGURATION
// ============================================================================

var config = {
    // Charging targets
    targetSOC: 80,
    readyByHour: 7,
    readyByMinute: 30,

    // Cheap rate window (Intelligent Octopus Go)
    cheapWindowStart: { hour: 23, minute: 30 },
    cheapWindowEnd: { hour: 5, minute: 30 },

    // Electricity rates (£/kWh)
    cheapRate: 0.07,
    standardRate: 0.292,

    // Charger
    chargerRate: 1.8  // kW (granny charger default)
};

var state = {
    monitoring: false,
    subscribed: false,
    lastPluggedIn: false,  // Track plug state changes
    scheduledStartMin: null,  // Minutes from midnight
    scheduledEndMin: null,
    scheduledKwhNeeded: null,
    scheduledCost: null,
    scheduledMessage: null
};

// ============================================================================
// PERSISTENCE
// ============================================================================

function loadConfig() {
    try {
        var val, parsed;

        // Target SOC
        val = OvmsConfig.Get("usr", "charging.target.soc");
        if (val && val !== "") {
            parsed = parseInt(val);
            if (!isNaN(parsed) && parsed >= 20 && parsed <= 100) {
                config.targetSOC = parsed;
            }
        }

        // Ready-by time
        val = OvmsConfig.Get("usr", "charging.readyby.hour");
        if (val && val !== "") {
            parsed = parseInt(val);
            if (!isNaN(parsed) && parsed >= 0 && parsed <= 23) {
                config.readyByHour = parsed;
            }
        }

        val = OvmsConfig.Get("usr", "charging.readyby.minute");
        if (val && val !== "") {
            parsed = parseInt(val);
            if (!isNaN(parsed) && parsed >= 0 && parsed <= 59) {
                config.readyByMinute = parsed;
            }
        }

        // Cheap window
        val = OvmsConfig.Get("usr", "charging.window.start.hour");
        if (val && val !== "") {
            config.cheapWindowStart.hour = parseInt(val);
            config.cheapWindowStart.minute = parseInt(
                OvmsConfig.Get("usr", "charging.window.start.minute") || "0"
            );
            config.cheapWindowEnd.hour = parseInt(
                OvmsConfig.Get("usr", "charging.window.end.hour") || "0"
            );
            config.cheapWindowEnd.minute = parseInt(
                OvmsConfig.Get("usr", "charging.window.end.minute") || "0"
            );
        }

        // Rates
        val = OvmsConfig.Get("usr", "charging.pricing.cheap");
        if (val && val !== "") {
            parsed = parseFloat(val);
            if (!isNaN(parsed) && parsed > 0) {
                config.cheapRate = parsed;
            }
        }

        val = OvmsConfig.Get("usr", "charging.pricing.standard");
        if (val && val !== "") {
            parsed = parseFloat(val);
            if (!isNaN(parsed) && parsed > 0) {
                config.standardRate = parsed;
            }
        }

        // Charger rate
        val = OvmsConfig.Get("usr", "charging.charger.rate");
        if (val && val !== "") {
            parsed = parseFloat(val);
            if (!isNaN(parsed) && parsed > 0) {
                config.chargerRate = parsed;
            }
        }

        print("Config loaded: Target " + config.targetSOC + "%, Ready by " +
              formatTime(config.readyByHour, config.readyByMinute) + "\n");

    } catch (e) {
        print("Config load error: " + e.message + "\n");
    }
}

function saveConfig(key, value) {
    try {
        OvmsConfig.Set("usr", key, String(value));
    } catch (e) {
        print("Config save error: " + key + " - " + e.message + "\n");
    }
}

// ============================================================================
// METRICS HELPERS
// ============================================================================

function getMetric(name, defaultVal) {
    try {
        if (OvmsMetrics.HasValue(name)) {
            return OvmsMetrics.AsFloat(name);
        }
        return defaultVal;
    } catch (e) {
        return defaultVal;
    }
}

function getSOC() {
    return getMetric("v.b.soc", 0);
}

function getSOH() {
    var soh = getMetric("v.b.soh", 0);
    return (soh > 0) ? soh : 100;
}

function getBatteryCapacity() {
    var cac = getMetric("v.b.cac.ah", 0);
    if (cac > 0) {
        var voltage = getMetric("v.b.voltage", 360);
        return (cac * voltage) / 1000;
    }
    return getMetric("v.b.energy.full", 40);
}

function isPluggedIn() {
    return getMetric("v.c.pilot", 0) !== 0;
}

function isCharging() {
    return getMetric("v.c.charging", 0) !== 0;
}

// ============================================================================
// TIME CALCULATIONS
// ============================================================================

function timeToMinutes(hour, minute) {
    return hour * 60 + minute;
}

function minutesToTime(mins) {
    var h = Math.floor(mins / 60) % 24;
    var m = mins % 60;
    return { hour: h, minute: m };
}

function getCurrentMinutes() {
    var d = new Date();
    return d.getHours() * 60 + d.getMinutes();
}

// Normalize a time relative to a reference point (typically ready_by)
// Times after the reference (on the 24-hour clock) are treated as "yesterday"
// This creates a linear timeline for proper temporal comparison
function normalizeToReference(timeMin, referenceMin) {
    if (timeMin > referenceMin) {
        return timeMin - 1440;  // Shift back by one day
    }
    return timeMin;
}

function isInCheapWindow(mins) {
    var startMin = timeToMinutes(config.cheapWindowStart.hour, config.cheapWindowStart.minute);
    var endMin = timeToMinutes(config.cheapWindowEnd.hour, config.cheapWindowEnd.minute);

    if (startMin > endMin) {
        // Window crosses midnight (e.g., 23:30-05:30)
        return (mins >= startMin || mins < endMin);
    } else {
        return (mins >= startMin && mins < endMin);
    }
}

// ============================================================================
// SCHEDULE CALCULATION
// ============================================================================

function calculateSchedule(currentSOC, targetSOC) {
    // SOH-aware capacity
    var soh = getSOH();
    var nominalCapacity = getBatteryCapacity();
    var effectiveCapacity = nominalCapacity * (soh / 100);

    // Energy needed
    var socNeeded = targetSOC - currentSOC;
    var kwhNeeded = (socNeeded / 100) * effectiveCapacity;
    var hoursNeeded = kwhNeeded / config.chargerRate;

    // Time references
    var readyByMin = timeToMinutes(config.readyByHour, config.readyByMinute);
    var cheapStartMin = timeToMinutes(config.cheapWindowStart.hour, config.cheapWindowStart.minute);
    var cheapEndMin = timeToMinutes(config.cheapWindowEnd.hour, config.cheapWindowEnd.minute);

    // Calculate latest start time to be ready
    var latestStartMin = readyByMin - Math.ceil(hoursNeeded * 60);
    if (latestStartMin < 0) {
        latestStartMin += 1440;  // Wrap to previous day
    }

    // Determine actual start time
    var scheduledStartMin;
    var mustStartEarly = false;

    // Normalize all times relative to readyBy to handle day-wrap correctly
    // This ensures we're comparing times in the correct temporal order
    var cheapStartNormalized = normalizeToReference(cheapStartMin, readyByMin);
    var latestStartNormalized = normalizeToReference(latestStartMin, readyByMin);

    // Now we can compare: if latest start comes after (or at same time as) cheap start,
    // we can wait for the cheap window
    if (latestStartNormalized >= cheapStartNormalized) {
        // Can wait for cheap window
        scheduledStartMin = cheapStartMin;
    } else {
        // Must start before cheap window (latest start is earlier than cheap start)
        scheduledStartMin = latestStartMin;
        mustStartEarly = true;
    }

    // Calculate end time
    var scheduledEndMin = (scheduledStartMin + Math.ceil(hoursNeeded * 60)) % 1440;

    // Calculate costs
    var cheapHours = 0;
    var overspillHours = 0;
    var windowDuration;

    if (cheapEndMin >= cheapStartMin) {
        windowDuration = (cheapEndMin - cheapStartMin) / 60;
    } else {
        windowDuration = ((1440 - cheapStartMin) + cheapEndMin) / 60;
    }

    if (mustStartEarly) {
        // All at standard rate until cheap window, then cheap
        var hoursUntilCheap = (cheapStartMin - scheduledStartMin + 1440) % 1440 / 60;
        if (hoursUntilCheap > hoursNeeded) {
            overspillHours = hoursNeeded;  // All before cheap window
            cheapHours = 0;
        } else {
            overspillHours = hoursUntilCheap;
            cheapHours = hoursNeeded - hoursUntilCheap;
        }
    } else {
        // Starts in cheap window
        if (hoursNeeded <= windowDuration) {
            cheapHours = hoursNeeded;
            overspillHours = 0;
        } else {
            cheapHours = windowDuration;
            overspillHours = hoursNeeded - windowDuration;
        }
    }

    var cheapCost = cheapHours * config.chargerRate * config.cheapRate;
    var overspillCost = overspillHours * config.chargerRate * config.standardRate;
    var totalCost = cheapCost + overspillCost;

    return {
        kwhNeeded: kwhNeeded,
        hoursNeeded: hoursNeeded,
        scheduledStartMin: scheduledStartMin,
        scheduledEndMin: scheduledEndMin,
        mustStartEarly: mustStartEarly,
        cheapHours: cheapHours,
        overspillHours: overspillHours,
        totalCost: totalCost
    };
}

// ============================================================================
// NOTIFICATIONS
// ============================================================================

function notify(message) {
    var msg = "[" + timestamp() + "] " + message;
    print(msg + "\n");

    try {
        OvmsNotify.Raise("info", "charge.smart", msg);
    } catch (e) {
        // Notification failed, but we printed to console
    }
}

// ============================================================================
// PLUG-IN DETECTION (called by ticker, not event)
// ============================================================================

function checkPlugInState() {
    var currentlyPlugged = isPluggedIn();

    // Detect state change: unplugged -> plugged
    if (currentlyPlugged && !state.lastPluggedIn) {
        print("Plug-in detected\n");
        onPlugInDetected();
    }

    // Detect state change: plugged -> unplugged
    if (!currentlyPlugged && state.lastPluggedIn) {
        print("Unplug detected\n");
        onUnplugDetected();
    }

    state.lastPluggedIn = currentlyPlugged;
}

function onPlugInDetected() {
    var currentSOC = getSOC();

    // Already at target?
    if (currentSOC >= config.targetSOC) {
        notify("Already at " + currentSOC.toFixed(0) + "% (target " +
               config.targetSOC + "%). No charge needed.");
        state.scheduledStartMin = null;
        return;
    }

    // Calculate schedule
    var schedule = calculateSchedule(currentSOC, config.targetSOC);

    // Store schedule
    state.scheduledStartMin = schedule.scheduledStartMin;
    state.scheduledEndMin = schedule.scheduledEndMin;
    state.scheduledKwhNeeded = schedule.kwhNeeded;
    state.scheduledCost = schedule.totalCost;

    // Build message
    var startTime = minutesToTime(schedule.scheduledStartMin);
    var endTime = minutesToTime(schedule.scheduledEndMin);

    var msg = "Scheduled for " + formatTime(startTime.hour, startTime.minute) +
              ". Will reach " + config.targetSOC + "% by " +
              formatTime(endTime.hour, endTime.minute) +
              ". Est. cost \u00A3" + schedule.totalCost.toFixed(2);

    if (schedule.mustStartEarly) {
        msg += " (must start early)";
    } else if (schedule.overspillHours > 0) {
        msg += " (includes " + schedule.overspillHours.toFixed(1) + "h at standard rate)";
    }

    state.scheduledMessage = msg;
    notify(msg);
}

function onUnplugDetected() {
    state.scheduledStartMin = null;
    state.scheduledEndMin = null;
    state.scheduledKwhNeeded = null;
    state.scheduledCost = null;
    state.scheduledMessage = null;
    state.monitoring = false;
    print("Schedule cleared\n");
}

// ============================================================================
// SCHEDULE CHECKER (called by ticker.60)
// ============================================================================

function checkSchedule() {
    try {
        // Check for plug state changes first
        checkPlugInState();

        var nowMin = getCurrentMinutes();
        var currentSOC = getSOC();
        var charging = isCharging();
        var plugged = isPluggedIn();

        // Auto-start at scheduled time
        if (state.scheduledStartMin !== null && !charging && plugged &&
            currentSOC < config.targetSOC) {

            // Calculate time difference (handle day wrap)
            var diff = nowMin - state.scheduledStartMin;
            if (diff < -720) {
                diff += 1440;
            } else if (diff > 720) {
                diff -= 1440;
            }

            // Start if at or after scheduled time (within 6 hour window)
            if (diff >= 0 && diff <= 360) {
                print("Schedule triggered: starting charge\n");
                startCharging();
            }
        }

    } catch (e) {
        print("checkSchedule error: " + e.message + "\n");
    }
}

// ============================================================================
// TICKER HANDLER (called by ticker.60)
// ============================================================================

function tickerHandler() {
    checkSchedule();
    monitorSOC();
}

// ============================================================================
// SOC MONITORING (called by ticker.60)
// ============================================================================

function monitorSOC() {
    try {
        var charging = isCharging();
        var soc = getSOC();

        // Auto-enable monitoring when charging detected
        if (charging && soc < config.targetSOC && !state.monitoring) {
            state.monitoring = true;
            print("Monitoring enabled (charge in progress)\n");
        }

        if (!state.monitoring) {
            return;
        }

        if (!charging) {
            state.monitoring = false;
            return;
        }

        if (soc >= config.targetSOC) {
            notify("Target reached: " + soc.toFixed(0) + "%");
            stopCharging();
        }

    } catch (e) {
        // Silent fail
    }
}

// ============================================================================
// CHARGING CONTROL
// ============================================================================

function startCharging() {
    try {
        OvmsCommand.Exec("charge start");
        state.monitoring = true;
        notify("Charging started. Target " + config.targetSOC + "%.");
    } catch (e) {
        print("Start charging error: " + e.message + "\n");
    }
}

function stopCharging() {
    try {
        OvmsCommand.Exec("charge stop");
        state.monitoring = false;
        print("Charging stopped\n");
    } catch (e) {
        print("Stop charging error: " + e.message + "\n");
    }
}

// ============================================================================
// USER COMMANDS
// ============================================================================

exports.setTarget = function(soc) {
    if (soc >= 20 && soc <= 100) {
        config.targetSOC = soc;
        saveConfig("charging.target.soc", soc);
        print("Target set to " + soc + "%\n");
        return "Target: " + soc + "%";
    }
    return "Error: SOC must be 20-100";
};

exports.setReadyBy = function(hour, minute) {
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
        config.readyByHour = hour;
        config.readyByMinute = minute;
        saveConfig("charging.readyby.hour", hour);
        saveConfig("charging.readyby.minute", minute);
        print("Ready-by set to " + formatTime(hour, minute) + "\n");
        return "Ready by: " + formatTime(hour, minute);
    }
    return "Error: Invalid time";
};

exports.setWindow = function(startHour, startMin, endHour, endMin) {
    config.cheapWindowStart.hour = startHour;
    config.cheapWindowStart.minute = startMin;
    config.cheapWindowEnd.hour = endHour;
    config.cheapWindowEnd.minute = endMin;
    saveConfig("charging.window.start.hour", startHour);
    saveConfig("charging.window.start.minute", startMin);
    saveConfig("charging.window.end.hour", endHour);
    saveConfig("charging.window.end.minute", endMin);
    print("Cheap window: " + formatTime(startHour, startMin) + " - " +
          formatTime(endHour, endMin) + "\n");
    return "Window: " + formatTime(startHour, startMin) + " - " + formatTime(endHour, endMin);
};

exports.setRates = function(cheap, standard) {
    config.cheapRate = cheap;
    config.standardRate = standard;
    saveConfig("charging.pricing.cheap", cheap);
    saveConfig("charging.pricing.standard", standard);
    print("Rates: \u00A3" + cheap + " (cheap), \u00A3" + standard + " (standard)\n");
    return "Rates: " + cheap + "/" + standard;
};

exports.setCharger = function(kw) {
    config.chargerRate = kw;
    saveConfig("charging.charger.rate", kw);
    print("Charger rate: " + kw + " kW\n");
    return "Charger: " + kw + " kW";
};

exports.start = function() {
    var soc = getSOC();
    var plugged = isPluggedIn();

    if (!plugged) {
        print("Not plugged in\n");
        return "Error: Not plugged in";
    }

    if (soc >= config.targetSOC) {
        print("Already at target\n");
        return "Already at target";
    }

    startCharging();
    return "Charging: " + soc.toFixed(0) + "% -> " + config.targetSOC + "%";
};

exports.stop = function() {
    stopCharging();
    return "Charging stopped";
};

exports.status = function() {
    var soc = getSOC();
    var soh = getSOH();
    var plugged = isPluggedIn();
    var charging = isCharging();

    var lines = [];
    lines.push("=== Smart Charging v" + VERSION + " ===");
    lines.push("SOC: " + soc.toFixed(0) + "% (target " + config.targetSOC + "%)");
    lines.push("SOH: " + soh.toFixed(0) + "%");
    lines.push("Plugged: " + (plugged ? "Yes" : "No"));
    lines.push("Charging: " + (charging ? "Yes" : "No"));
    lines.push("Ready by: " + formatTime(config.readyByHour, config.readyByMinute));
    lines.push("Cheap window: " + formatTime(config.cheapWindowStart.hour, config.cheapWindowStart.minute) +
               " - " + formatTime(config.cheapWindowEnd.hour, config.cheapWindowEnd.minute));

    if (state.scheduledStartMin !== null) {
        var startTime = minutesToTime(state.scheduledStartMin);
        var endTime = minutesToTime(state.scheduledEndMin);
        lines.push("Scheduled: " + formatTime(startTime.hour, startTime.minute) +
                   " - " + formatTime(endTime.hour, endTime.minute));
        lines.push("Est. cost: \u00A3" + state.scheduledCost.toFixed(2));
    } else {
        lines.push("Schedule: None");
    }

    lines.push("Monitoring: " + (state.monitoring ? "Active" : "Inactive"));

    var output = lines.join("\n");
    print(output + "\n");

    try {
        OvmsNotify.Raise("info", "charge.status", output);
    } catch (e) {}

    return output;
};

// ============================================================================
// INITIALIZATION
// ============================================================================

loadConfig();

// Initialize plug state to false - will detect on first ticker
// This avoids OvmsMetrics calls during module load which can stall JS engine
state.lastPluggedIn = false;

// Subscribe to ticker for monitoring (passive approach)
if (!state.subscribed) {
    PubSub.subscribe("ticker.60", tickerHandler);
    state.subscribed = true;
    print("Ticker monitoring active\n");
}

print("Ready\n");
