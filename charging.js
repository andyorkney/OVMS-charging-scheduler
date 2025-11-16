/**
 * OVMS Smart Charging Scheduler
 *
 * VERSION: 3.1.0
 * BUILD: Smart scheduling with ready-by time, SOH-aware calculations, cost estimates,
 *        and automatic charge interruption recovery with climate wake cycle
 *
 * FEATURES:
 * - Ready-by time scheduling (reach target SOC by departure time)
 * - SOH-aware battery capacity calculations
 * - Cost estimates with cheap/standard rates (Intelligent Octopus Go)
 * - Timestamps on all notifications [HH:MM]
 * - Automatic charge interruption recovery with climate wake retry
 * - Auto-stop on plug-in with schedule notification
 * - Overspill warnings (charging beyond cheap window)
 *
 * ES5.1/DUKTAPE COMPATIBILITY:
 * - NO async/await (crashes engine)
 * - NO arrow functions
 * - NO template literals
 * - NO let/const (use var)
 * - NO .repeat(), .includes(), .padStart()
 * - Uses setTimeout-like callbacks via ticker pattern
 *
 * USAGE:
 * charging.setTarget(80)              - Set SOC target to 80%
 * charging.setReadyBy(7, 30)          - Set ready-by to 07:30
 * charging.setWindow(23, 30, 5, 30)   - Cheap window 23:30-05:30
 * charging.setRates(0.07, 0.292)      - Set cheap/standard rates (£/kWh)
 * charging.setCharger(1.8)            - Set charger rate (kW)
 * charging.status()                   - Show current status
 * charging.start()                    - Manual start (override schedule)
 * charging.stop()                     - Manual stop
 */

// ============================================================================
// VERSION & MODULE INFO
// ============================================================================

var VERSION = "3.2.0";

if (typeof exports === 'undefined') {
    var exports = {};
}

// ============================================================================
// UTILITIES (ES5.1 compatible)
// ============================================================================

function pad(n) {
    return n < 10 ? "0" + n : n.toString();
}

function repeatString(str, count) {
    var result = "";
    for (var i = 0; i < count; i++) {
        result += str;
    }
    return result;
}

function getTimestamp() {
    var now = new Date();
    return "[" + pad(now.getHours()) + ":" + pad(now.getMinutes()) + "]";
}

function timestamp() {
    return new Date().toLocaleString();
}

// ============================================================================
// LOGGER UTILITY
// ============================================================================

function logger() {
    function log(message, obj) {
        print(message + (obj ? ' ' + JSON.stringify(obj) : '') + '\n');
    }

    function debug(message, obj) {
        // Enable for troubleshooting: uncomment next line
        // log('(' + timestamp() + ') DEBUG: ' + message, obj);
    }

    function error(message, obj) {
        log('(' + timestamp() + ') ERROR: ' + message, obj);
    }

    function info(message, obj) {
        log('(' + timestamp() + ') INFO: ' + message, obj);
    }

    function warn(message, obj) {
        log('(' + timestamp() + ') WARN: ' + message, obj);
    }

    return { debug: debug, error: error, info: info, log: log, warn: warn };
}

var console = logger();

console.info("OVMS Smart Charging v" + VERSION);
print(repeatString("=", 50) + "\n");

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
    chargerRate: 1.8,           // kW (granny charger default)
    batteryOverride: 0,         // 0 = auto-detect
    sohOverride: 0              // 0 = auto-detect
};

var state = {
    // Monitoring flags
    monitoring: false,
    subscribed: false,
    manualOverride: false,
    scheduledChargeActive: false,

    // Retry state for charge interruptions
    retryCount: 0,
    retryTimerId: null,

    // Schedule info
    scheduledStartTime: null,
    scheduledEndTime: null,

    // Timer management
    pendingTimers: [],
    timerCounter: 0
};

// ============================================================================
// PERSISTENCE (OVMS Config)
// ============================================================================

function loadConfig() {
    try {
        var val, parsed;

        val = OvmsConfig.Get("usr", "charging.target_soc");
        if (val && val !== "") {
            parsed = parseInt(val);
            if (!isNaN(parsed) && parsed >= 20 && parsed <= 100) {
                config.targetSOC = parsed;
            }
        }

        val = OvmsConfig.Get("usr", "charging.ready_by_hour");
        if (val && val !== "") {
            parsed = parseInt(val);
            if (!isNaN(parsed) && parsed >= 0 && parsed <= 23) {
                config.readyByHour = parsed;
            }
        }

        val = OvmsConfig.Get("usr", "charging.ready_by_minute");
        if (val && val !== "") {
            parsed = parseInt(val);
            if (!isNaN(parsed) && parsed >= 0 && parsed <= 59) {
                config.readyByMinute = parsed;
            }
        }

        val = OvmsConfig.Get("usr", "charging.cheap_start_hour");
        if (val && val !== "") {
            parsed = parseInt(val);
            if (!isNaN(parsed) && parsed >= 0 && parsed <= 23) {
                config.cheapWindowStart.hour = parsed;
            }
        }

        val = OvmsConfig.Get("usr", "charging.cheap_start_minute");
        if (val && val !== "") {
            parsed = parseInt(val);
            if (!isNaN(parsed) && parsed >= 0 && parsed <= 59) {
                config.cheapWindowStart.minute = parsed;
            }
        }

        val = OvmsConfig.Get("usr", "charging.cheap_end_hour");
        if (val && val !== "") {
            parsed = parseInt(val);
            if (!isNaN(parsed) && parsed >= 0 && parsed <= 23) {
                config.cheapWindowEnd.hour = parsed;
            }
        }

        val = OvmsConfig.Get("usr", "charging.cheap_end_minute");
        if (val && val !== "") {
            parsed = parseInt(val);
            if (!isNaN(parsed) && parsed >= 0 && parsed <= 59) {
                config.cheapWindowEnd.minute = parsed;
            }
        }

        val = OvmsConfig.Get("usr", "charging.cheap_rate");
        if (val && val !== "") {
            parsed = parseFloat(val);
            if (!isNaN(parsed) && parsed > 0) {
                config.cheapRate = parsed;
            }
        }

        val = OvmsConfig.Get("usr", "charging.standard_rate");
        if (val && val !== "") {
            parsed = parseFloat(val);
            if (!isNaN(parsed) && parsed > 0) {
                config.standardRate = parsed;
            }
        }

        val = OvmsConfig.Get("usr", "charging.charger_rate");
        if (val && val !== "") {
            parsed = parseFloat(val);
            if (!isNaN(parsed) && parsed > 0) {
                config.chargerRate = parsed;
            }
        }

    } catch (e) {
        console.error("Load config failed", e);
    }
}

function saveConfig(key, value) {
    try {
        OvmsConfig.Set("usr", key, value.toString());
    } catch (e) {
        console.error("Save config failed: " + key, e);
    }
}

// ============================================================================
// METRICS HELPERS
// ============================================================================

function getMetric(name, def) {
    try {
        return OvmsMetrics.HasValue(name) ? OvmsMetrics.AsFloat(name) : def;
    } catch (e) {
        return def;
    }
}

function getSOC() {
    return getMetric('v.b.soc', 0);
}

function getSOH() {
    var soh = getMetric('v.b.soh', 0);
    return soh > 0 ? soh : 100; // Default to 100% if not available
}

function getBatteryCapacity() {
    if (config.batteryOverride > 0) {
        return config.batteryOverride;
    }
    return getMetric('v.b.cac.ah', 0) > 0 ?
           getMetric('v.b.cac.ah', 40) * getMetric('v.b.voltage', 360) / 1000 :
           getMetric('v.b.energy.full', 40);
}

function isPluggedIn() {
    // AsFloat returns 0 or 1 for boolean metrics
    return getMetric("v.c.pilot", 0) != 0;
}

function isCharging() {
    // AsFloat returns 0 or 1 for boolean metrics
    return getMetric("v.c.charging", 0) != 0;
}

function kmToMiles(km) {
    return km * 0.621371;
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

function formatTime(hour, minute) {
    return pad(hour) + ":" + pad(minute);
}

function getCurrentMinutes() {
    var now = new Date();
    return now.getHours() * 60 + now.getMinutes();
}

// ============================================================================
// CHARGE CALCULATIONS (SOH-AWARE)
// ============================================================================

function calculateEffectiveCapacity() {
    var nominal = getBatteryCapacity();
    var soh = config.sohOverride > 0 ? config.sohOverride : getSOH();
    return nominal * (soh / 100);
}

function calculateEnergyNeeded(currentSOC, targetSOC) {
    var socNeeded = targetSOC - currentSOC;
    var effectiveCapacity = calculateEffectiveCapacity();
    return (socNeeded / 100) * effectiveCapacity;
}

function calculateChargeDuration(kwhNeeded) {
    // Hours needed at configured charger rate
    return kwhNeeded / config.chargerRate;
}

function calculateCosts(hoursNeeded) {
    var cheapStartMin = timeToMinutes(config.cheapWindowStart.hour, config.cheapWindowStart.minute);
    var cheapEndMin = timeToMinutes(config.cheapWindowEnd.hour, config.cheapWindowEnd.minute);

    // Calculate cheap window duration (handles overnight)
    var cheapWindowHours;
    if (cheapEndMin <= cheapStartMin) {
        // Overnight window (e.g., 23:30 to 05:30)
        cheapWindowHours = (1440 - cheapStartMin + cheapEndMin) / 60;
    } else {
        cheapWindowHours = (cheapEndMin - cheapStartMin) / 60;
    }

    var cheapHours = Math.min(hoursNeeded, cheapWindowHours);
    var overspillHours = Math.max(0, hoursNeeded - cheapWindowHours);

    var cheapCost = cheapHours * config.chargerRate * config.cheapRate;
    var overspillCost = overspillHours * config.chargerRate * config.standardRate;
    var totalCost = cheapCost + overspillCost;

    return {
        cheapHours: cheapHours,
        overspillHours: overspillHours,
        cheapCost: cheapCost,
        overspillCost: overspillCost,
        totalCost: totalCost
    };
}

// ============================================================================
// SCHEDULING LOGIC
// ============================================================================

function calculateSchedule(currentSOC, targetSOC) {
    var kwhNeeded = calculateEnergyNeeded(currentSOC, targetSOC);
    var hoursNeeded = calculateChargeDuration(kwhNeeded);

    var readyByMin = timeToMinutes(config.readyByHour, config.readyByMinute);
    var cheapStartMin = timeToMinutes(config.cheapWindowStart.hour, config.cheapWindowStart.minute);
    var cheapEndMin = timeToMinutes(config.cheapWindowEnd.hour, config.cheapWindowEnd.minute);
    var nowMin = getCurrentMinutes();

    // Calculate latest start time to meet ready-by
    var hoursNeededMins = Math.ceil(hoursNeeded * 60);
    var latestStartMin = readyByMin - hoursNeededMins;

    // Handle day wrap (if latest start is negative, it's yesterday)
    if (latestStartMin < 0) {
        latestStartMin += 1440; // Add 24 hours
    }

    var scheduledStartMin;
    var mustStartEarly = false;

    // Determine if we can wait for cheap window
    // Check if cheap window start allows us to finish by ready-by time
    var canUseCheapWindow = true;

    // Calculate finish time if starting at cheap window start
    var finishIfStartAtCheap = cheapStartMin + hoursNeededMins;
    if (finishIfStartAtCheap >= 1440) {
        finishIfStartAtCheap -= 1440;
    }

    // Check if this finish time is before ready-by
    // This is complex due to day wrapping, simplify:
    if (hoursNeededMins > (readyByMin - cheapStartMin + 1440) % 1440) {
        // Starting at cheap window won't finish in time
        canUseCheapWindow = false;
        mustStartEarly = true;
        scheduledStartMin = latestStartMin;
    } else {
        scheduledStartMin = cheapStartMin;
    }

    // Calculate scheduled end time
    var scheduledEndMin = scheduledStartMin + hoursNeededMins;
    if (scheduledEndMin >= 1440) {
        scheduledEndMin -= 1440;
    }

    var costs = calculateCosts(hoursNeeded);

    return {
        currentSOC: currentSOC,
        targetSOC: targetSOC,
        kwhNeeded: kwhNeeded,
        hoursNeeded: hoursNeeded,
        scheduledStartMin: scheduledStartMin,
        scheduledEndMin: scheduledEndMin,
        mustStartEarly: mustStartEarly,
        costs: costs,
        scheduledStartTime: minutesToTime(scheduledStartMin),
        scheduledEndTime: minutesToTime(scheduledEndMin)
    };
}

// ============================================================================
// NOTIFICATIONS (All with timestamps)
// ============================================================================

function notify(message) {
    var fullMessage = getTimestamp() + " " + message;
    console.info(fullMessage);

    try {
        OvmsNotify.Raise("alert", "usr.charging.smart", fullMessage);
    } catch (e) {
        console.error("Notification failed", e);
    }
}

// ============================================================================
// TIMER MANAGEMENT (ES5.1 compatible setTimeout alternative)
// ============================================================================

function scheduleAfterDelay(callback, delayMs) {
    var timerId = ++state.timerCounter;
    var executeTime = Date.now() + delayMs;

    state.pendingTimers.push({
        id: timerId,
        callback: callback,
        executeTime: executeTime
    });

    console.info("Scheduled timer " + timerId + " for " + delayMs + "ms");
    return timerId;
}

function cancelTimer(timerId) {
    var remaining = [];
    for (var i = 0; i < state.pendingTimers.length; i++) {
        if (state.pendingTimers[i].id !== timerId) {
            remaining.push(state.pendingTimers[i]);
        }
    }
    state.pendingTimers = remaining;
}

function processPendingTimers() {
    var now = Date.now();
    var remaining = [];

    for (var i = 0; i < state.pendingTimers.length; i++) {
        var timer = state.pendingTimers[i];
        if (now >= timer.executeTime) {
            console.info("Executing timer " + timer.id);
            try {
                timer.callback();
            } catch (e) {
                console.error("Timer callback failed", e);
            }
        } else {
            remaining.push(timer);
        }
    }

    state.pendingTimers = remaining;
}

// ============================================================================
// CLIMATE WAKE CYCLE (for charge recovery)
// ============================================================================

function performClimateWake(callback) {
    console.info("Starting climate wake cycle");

    try {
        OvmsCommand.Exec("climatecontrol on");
        console.info("Climate ON");
    } catch (e) {
        console.error("Climate ON failed", e);
    }

    // Wait 10 seconds, then turn off
    scheduleAfterDelay(function() {
        try {
            OvmsCommand.Exec("climatecontrol off");
            console.info("Climate OFF");
        } catch (e) {
            console.error("Climate OFF failed", e);
        }

        // Wait 5 more seconds, then callback
        scheduleAfterDelay(function() {
            console.info("Climate wake cycle complete");
            if (callback) {
                callback();
            }
        }, 5000);
    }, 10000);
}

// ============================================================================
// CHARGE INTERRUPTION HANDLER
// ============================================================================

function handleChargeInterruption() {
    if (!state.scheduledChargeActive) {
        return; // Not a scheduled charge, ignore
    }

    if (state.manualOverride) {
        notify("Charging stopped. (Manual charge - no auto-retry)");
        state.scheduledChargeActive = false;
        state.monitoring = false;
        return;
    }

    var currentSOC = getSOC();
    state.retryCount++;

    if (state.retryCount > 3) {
        notify("Charging failed multiple times at " + currentSOC.toFixed(0) +
               "% (target " + config.targetSOC + "%). Please check vehicle and charger.");
        state.scheduledChargeActive = false;
        state.monitoring = false;
        state.retryCount = 0;
        return;
    }

    // Determine retry delay
    var delayMinutes;
    if (state.retryCount === 1) {
        delayMinutes = 2;
    } else if (state.retryCount === 2) {
        delayMinutes = 5;
    } else {
        delayMinutes = 10;
    }

    notify("Charging interrupted at " + currentSOC.toFixed(0) +
           "%. Retrying in " + delayMinutes + " minutes... (attempt " +
           state.retryCount + "/3)");

    // Schedule retry after delay
    var delayMs = delayMinutes * 60 * 1000;
    state.retryTimerId = scheduleAfterDelay(function() {
        attemptChargeRestart();
    }, delayMs);
}

function attemptChargeRestart() {
    // Verify still plugged in
    if (!isPluggedIn()) {
        notify("Cannot restart - vehicle not plugged in.");
        state.scheduledChargeActive = false;
        state.monitoring = false;
        state.retryCount = 0;
        return;
    }

    var currentSOC = getSOC();

    // Verify still needs charging
    if (currentSOC >= config.targetSOC) {
        notify("Target reached: " + currentSOC.toFixed(0) + "%");
        state.scheduledChargeActive = false;
        state.monitoring = false;
        state.retryCount = 0;
        return;
    }

    // Perform climate wake cycle, then restart
    performClimateWake(function() {
        try {
            OvmsCommand.Exec("charge start");
            notify("Charging restarted. Target " + config.targetSOC + "%.");
            // Reset retry count on successful restart
            // (will increment again if it fails immediately)
        } catch (e) {
            console.error("Charge restart failed", e);
            // Will be caught by next monitoring cycle
        }
    });
}

// ============================================================================
// SOC MONITORING
// ============================================================================

function monitorSOC() {
    // Process pending timers first
    processPendingTimers();

    if (!state.monitoring) {
        return;
    }

    var charging = isCharging();
    var currentSOC = getSOC();

    if (!charging && state.scheduledChargeActive) {
        // Charging stopped unexpectedly - handle interruption
        console.info("Charge interruption detected at " + currentSOC.toFixed(1) + "%");
        handleChargeInterruption();
        return;
    }

    if (!charging) {
        console.info("Monitor: Not charging");
        state.monitoring = false;
        return;
    }

    console.info("Monitor: SOC=" + currentSOC.toFixed(1) + "% Target=" + config.targetSOC + "%");

    // Check if target reached
    if (currentSOC >= config.targetSOC) {
        try {
            OvmsCommand.Exec("charge stop");
        } catch (e) {
            console.error("Stop command failed", e);
        }

        notify("Charged to " + currentSOC.toFixed(0) + "%");
        state.scheduledChargeActive = false;
        state.monitoring = false;
        state.retryCount = 0;
    }
}

// ============================================================================
// ON PLUG-IN HANDLER
// ============================================================================

function onPlugIn() {
    console.info("Vehicle plugged in - calculating schedule");

    var currentSOC = getSOC();

    // Already at target?
    if (currentSOC >= config.targetSOC) {
        // Stop any auto-started charging
        try {
            OvmsCommand.Exec("charge stop");
        } catch (e) {
            // May not be charging
        }
        notify("Already at " + currentSOC.toFixed(0) + "% (target " +
               config.targetSOC + "%). Charge skipped.");
        return;
    }

    // Calculate schedule
    var schedule = calculateSchedule(currentSOC, config.targetSOC);

    // Stop auto-started charging (ENV200 auto-starts)
    try {
        OvmsCommand.Exec("charge stop");
        console.info("Auto-charge stopped, will resume at scheduled time");
    } catch (e) {
        // May not have started yet
    }

    // Store schedule
    state.scheduledStartTime = schedule.scheduledStartMin;
    state.scheduledEndTime = schedule.scheduledEndMin;

    // Build notification message
    var msg = "Scheduled for " + formatTime(schedule.scheduledStartTime.hour,
                                             schedule.scheduledStartTime.minute) +
              ". Will reach " + config.targetSOC + "% by " +
              formatTime(schedule.scheduledEndTime.hour, schedule.scheduledEndTime.minute) +
              ". Est. cost £" + schedule.costs.totalCost.toFixed(2);

    if (schedule.mustStartEarly) {
        var hoursEarly = (timeToMinutes(config.cheapWindowStart.hour, config.cheapWindowStart.minute) -
                         schedule.scheduledStartMin + 1440) % 1440 / 60;
        msg += " (must start " + hoursEarly.toFixed(1) + "h before cheap window)";
    } else if (schedule.costs.overspillHours > 0) {
        msg += " (includes " + schedule.costs.overspillHours.toFixed(1) + "h at standard rate)";
    }

    notify(msg);
}

// ============================================================================
// SCHEDULE CHECKER (called by clock events)
// ============================================================================

exports.checkSchedule = function() {
    var startTime = Date.now();

    try {
        var nowMin = getCurrentMinutes();
        var currentSOC = getSOC();
        var charging = isCharging();
        var plugged = isPluggedIn();

        // Skip if manual override active
        if (state.manualOverride) {
            return;
        }

        // Check if it's time to start scheduled charge
        if (state.scheduledStartTime !== null && !charging && plugged &&
            currentSOC < config.targetSOC) {

            // Check if current time matches scheduled start (within 30 min window)
            var diff = Math.abs(nowMin - state.scheduledStartTime);
            if (diff > 720) {
                diff = 1440 - diff; // Handle day wrap
            }

            if (diff <= 30) {
                console.info("Schedule: Starting scheduled charge");

                try {
                    OvmsCommand.Exec("charge start");
                    notify("Charging started. Target " + config.targetSOC + "%.");
                    state.scheduledChargeActive = true;
                    state.monitoring = true;
                    state.retryCount = 0;
                } catch (e) {
                    console.error("Scheduled start failed", e);
                }
            }
        }

    } catch (e) {
        console.error("checkSchedule failed", e);
    } finally {
        var duration = Date.now() - startTime;
        if (duration > 500) {
            console.warn("checkSchedule took " + duration + "ms");
        }
    }
};

// ============================================================================
// USER COMMANDS
// ============================================================================

exports.setTarget = function(soc) {
    if (soc < 20 || soc > 100) {
        console.error("Invalid target: " + soc + " (must be 20-100%)");
        return false;
    }
    config.targetSOC = soc;
    saveConfig("charging.target_soc", soc);
    console.info("Target set: " + soc + "%");
    return true;
};

exports.setReadyBy = function(hour, minute) {
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        console.error("Invalid time: " + hour + ":" + minute);
        return false;
    }
    config.readyByHour = hour;
    config.readyByMinute = minute;
    saveConfig("charging.ready_by_hour", hour);
    saveConfig("charging.ready_by_minute", minute);
    console.info("Ready-by set: " + formatTime(hour, minute));
    return true;
};

exports.setWindow = function(startHour, startMin, endHour, endMin) {
    config.cheapWindowStart = { hour: startHour, minute: startMin };
    config.cheapWindowEnd = { hour: endHour, minute: endMin };
    saveConfig("charging.cheap_start_hour", startHour);
    saveConfig("charging.cheap_start_minute", startMin);
    saveConfig("charging.cheap_end_hour", endHour);
    saveConfig("charging.cheap_end_minute", endMin);
    console.info("Cheap window: " + formatTime(startHour, startMin) +
                " to " + formatTime(endHour, endMin));
    return true;
};

exports.setRates = function(cheapRate, standardRate) {
    config.cheapRate = cheapRate;
    config.standardRate = standardRate;
    saveConfig("charging.cheap_rate", cheapRate);
    saveConfig("charging.standard_rate", standardRate);
    console.info("Rates: £" + cheapRate.toFixed(3) + " cheap, £" +
                standardRate.toFixed(3) + " standard");
    return true;
};

exports.setCharger = function(kw) {
    if (kw <= 0 || kw > 50) {
        console.error("Invalid charger rate: " + kw + " kW");
        return false;
    }
    config.chargerRate = kw;
    saveConfig("charging.charger_rate", kw);
    console.info("Charger rate: " + kw.toFixed(1) + " kW");
    return true;
};

// Legacy API compatibility
exports.setSchedule = function(sh, sm, eh, em) {
    return exports.setWindow(sh, sm, eh, em);
};

exports.setLimits = function(target) {
    return exports.setTarget(target);
};

// ============================================================================
// CHARGING CONTROL
// ============================================================================

exports.start = function() {
    var soc = getSOC();
    var plugged = isPluggedIn();

    if (!plugged) {
        console.warn("Start failed: Not plugged in");
        return "Error: Not plugged in";
    }

    if (soc >= config.targetSOC) {
        console.info("Start skipped: Already at target (" + soc.toFixed(0) + "%)");
        return "Already at target (" + soc.toFixed(0) + "%)";
    }

    try {
        state.manualOverride = true;
        state.scheduledChargeActive = false;
        state.monitoring = true;
        state.retryCount = 0;

        OvmsCommand.Exec("charge start");
        notify("Manual charge started. Target " + config.targetSOC + "%.");

        return "Charging started: " + soc.toFixed(0) + "% -> " + config.targetSOC + "%";
    } catch (e) {
        console.error("Start charging failed", e);
        return "Error: " + e.message;
    }
};

exports.stop = function() {
    try {
        state.monitoring = false;
        state.scheduledChargeActive = false;
        state.manualOverride = false;
        state.retryCount = 0;

        OvmsCommand.Exec("charge stop");
        console.info("Charging stopped");
        return "Charging stopped";
    } catch (e) {
        console.error("Stop charging failed", e);
        return "Error: " + e.message;
    }
};

// ============================================================================
// ON UNPLUG HANDLER
// ============================================================================

function onUnplug() {
    console.info("Vehicle unplugged - clearing schedule");

    state.scheduledChargeActive = false;
    state.manualOverride = false;
    state.monitoring = false;
    state.retryCount = 0;
    state.scheduledStartTime = null;
    state.scheduledEndTime = null;

    // Cancel any pending timers
    state.pendingTimers = [];
}

// ============================================================================
// STATUS DISPLAY
// ============================================================================

exports.status = function() {
    var output = "";

    output += "\nOVMS Smart Charging v" + VERSION + "\n";
    output += repeatString("=", 50) + "\n";

    // Configuration
    output += "Configuration:\n";
    output += "  Target SOC: " + config.targetSOC + "%\n";
    output += "  Ready by: " + formatTime(config.readyByHour, config.readyByMinute) + "\n";
    output += "  Cheap window: " + formatTime(config.cheapWindowStart.hour, config.cheapWindowStart.minute) +
          " to " + formatTime(config.cheapWindowEnd.hour, config.cheapWindowEnd.minute) + "\n";
    output += "  Rates: £" + config.cheapRate.toFixed(3) + " cheap, £" +
          config.standardRate.toFixed(3) + " standard\n";
    output += "  Charger: " + config.chargerRate.toFixed(1) + " kW\n";

    // Vehicle state
    var soc = getSOC();
    var soh = getSOH();
    var charging = isCharging();
    var plugged = isPluggedIn();
    var rangeKm = getMetric("v.b.range.est", 0);
    var effectiveCap = calculateEffectiveCapacity();

    output += "\nVehicle:\n";
    output += "  SOC: " + soc.toFixed(1) + "%\n";
    output += "  SOH: " + soh.toFixed(0) + "%\n";
    output += "  Effective capacity: " + effectiveCap.toFixed(1) + " kWh\n";
    output += "  Plugged in: " + (plugged ? "Yes" : "No") + "\n";
    output += "  Charging: " + (charging ? "Yes" : "No") + "\n";
    output += "  Est. range: " + kmToMiles(rangeKm).toFixed(0) + " miles\n";

    // State
    output += "\nState:\n";
    output += "  Monitoring: " + (state.monitoring ? "Yes" : "No") + "\n";
    output += "  Scheduled active: " + (state.scheduledChargeActive ? "Yes" : "No") + "\n";
    output += "  Manual override: " + (state.manualOverride ? "Yes" : "No") + "\n";
    output += "  Retry count: " + state.retryCount + "/3\n";

    if (state.scheduledStartTime !== null) {
        var startTime = minutesToTime(state.scheduledStartTime);
        output += "  Scheduled start: " + formatTime(startTime.hour, startTime.minute) + "\n";
    }

    // Preview schedule if plugged in but not charging
    if (plugged && !charging && soc < config.targetSOC) {
        var schedule = calculateSchedule(soc, config.targetSOC);
        output += "\nSchedule Preview:\n";
        output += "  Energy needed: " + schedule.kwhNeeded.toFixed(1) + " kWh\n";
        output += "  Duration: " + schedule.hoursNeeded.toFixed(1) + " hours\n";
        output += "  Start: " + formatTime(schedule.scheduledStartTime.hour,
                                        schedule.scheduledStartTime.minute) + "\n";
        output += "  Finish: " + formatTime(schedule.scheduledEndTime.hour,
                                         schedule.scheduledEndTime.minute) + "\n";
        output += "  Est. cost: £" + schedule.costs.totalCost.toFixed(2) + "\n";
        if (schedule.costs.overspillHours > 0) {
            output += "  WARNING: " + schedule.costs.overspillHours.toFixed(1) +
                  "h at standard rate (£" + schedule.costs.overspillCost.toFixed(2) + ")\n";
        }
    }

    output += "\n";

    // Print for console AND send to app via notification
    print(output);

    // Send to OVMS app (info notification for status queries)
    try {
        OvmsNotify.Raise("info", "charge.status", output);
    } catch (e) {
        console.warn("App notification failed");
    }

    return output;
};

// ============================================================================
// DEBUG
// ============================================================================

exports.debug = function() {
    var output = "";
    output += "\nDEBUG - Internal State\n";
    output += repeatString("=", 50) + "\n";
    output += "state.monitoring: " + state.monitoring + "\n";
    output += "state.subscribed: " + state.subscribed + "\n";
    output += "state.scheduledChargeActive: " + state.scheduledChargeActive + "\n";
    output += "state.manualOverride: " + state.manualOverride + "\n";
    output += "state.retryCount: " + state.retryCount + "\n";
    output += "state.pendingTimers: " + state.pendingTimers.length + "\n";
    output += "config.targetSOC: " + config.targetSOC + "\n";
    output += "Current SOC: " + getSOC().toFixed(1) + "%\n";
    output += "Charging: " + isCharging() + "\n";
    output += "Plugged: " + isPluggedIn() + "\n";
    output += "\n";

    print(output);
    return output;
};

// ============================================================================
// INITIALIZATION
// ============================================================================

loadConfig();

// Subscribe to events
if (!state.subscribed) {
    // SOC monitoring (every 60 seconds when charging)
    PubSub.subscribe("ticker.60", monitorSOC);

    // Plug-in events (try both - one will fire)
    PubSub.subscribe("vehicle.charge.start", onPlugIn);
    PubSub.subscribe("vehicle.charge.prepare", onPlugIn);

    // Unplug event
    PubSub.subscribe("vehicle.charge.pilot.off", onUnplug);

    state.subscribed = true;
    console.info("Event subscriptions active");
}

console.info("Config loaded - Target: " + config.targetSOC + "%, Ready by: " +
            formatTime(config.readyByHour, config.readyByMinute));
console.info("Ready for operation");
print(repeatString("=", 50) + "\n\n");
