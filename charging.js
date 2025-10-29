/**
 * OVMS Smart Charging Module v1.0
 * Universal charging scheduler with intelligent timing and cost optimisation
 *
 * QUICK START:
 * 1. Upload charging.js to /store/scripts/lib/charging.js
 * 2. Upload setup-events.js to /store/scripts/setup-events.js
 * 3. Add to /store/scripts/ovmsmain.js: charging = require("lib/charging");
 * 4. At the OVMS shell prompt, run:
 *    script eval setup = require("setup-events")
 *    script eval setup.install()
 * 5. Configure schedule:
 *    script eval charging.setSchedule(23, 30, 5, 30)
 * 6. Reload JS engine: Tools > Editor > "Reload JS Engine"
 *
 * See README.md for complete installation guide and troubleshooting
 *
 * PERFORMANCE:
 * - Module load time: <10ms typical
 * - No ticker events used (zero continuous CPU load)
 * - Event-driven architecture (only runs at scheduled times)
 * - Minimal 12V battery impact
 *
 * FEATURES:
 * - Auto-detects battery capacity and SOH from vehicle metrics
 * - Calculates optimal charge start time for "ready by" target
 * - Works with any charge rate (granny, Type 2, rapid)
 * - Prevents charging if SOC already sufficient
 * - Notifications for all actions (OVMS Connect app)
 * - User-friendly runtime configuration (no file editing!)
 * - Universal - works with any OVMS-supported EV
 *
 * USAGE - Information:
 * charging.status()                  - Show complete status
 * charging.nextCharge()              - Quick view of next charge session
 * charging.getSchedule()             - Show current schedule times
 *
 * USAGE - Manual Control:
 * charging.start()                   - Manual start
 * charging.stop()                    - Manual stop
 *
 * USAGE - Configuration:
 * charging.setSchedule(23,30,5,30)   - Set start/stop times (23:30 to 5:30)
 * charging.setLimits(80,75)          - Set target and skip threshold
 * charging.setChargeRate(1.8)        - Set your charger's kW rating
 * charging.setReadyBy(7,30)          - Intelligent: ready by 7:30
 * charging.clearReadyBy()            - Back to fixed schedule
 *
 * USAGE - Automation:
 * charging.checkSchedule()           - Check time and start/stop as needed
 *
 * SETUP:
 * Use the setup-events.js installer to create clock events automatically:
 *   script eval setup = require("setup-events")
 *   script eval setup.install()
 *
 * Then configure your schedule:
 *   script eval charging.setSchedule(23, 30, 5, 30)
 *   script eval charging.setLimits(80, 75)
 *
 * For detailed installation instructions, see README.md
 */

// ============================================================================
// MODULE LOAD TIME TRACKING
// ============================================================================

var __moduleLoadStart = Date.now();

// ============================================================================
// CONFIGURATION
// ============================================================================

var config = {
    // Cheap electricity rate window (24-hour format)
    cheapWindowStart: { hour: 23, minute: 30 },
    cheapWindowEnd: { hour: 5, minute: 30 },

    // Charging targets
    targetSOC: 80,          // Desired final SOC %
    skipIfAbove: 75,        // Skip charging if already above this %
    minSOCToCharge: 20,     // Safety: don't charge if below this (degraded battery protection)

    // Charger specification (kW)
    chargeRateKW: 1.8,      // 1.8=granny, 3.3=Type2 slow, 7=Type2 fast, 22+=rapid

    // Ready-by time (null = use fixed schedule)
    readyBy: null,          // Set via setReadyBy(hour, minute)

    // Battery parameters (null = auto-detect from vehicle)
    batteryCapacityKWh: null,
    batterySOH: null
};

// Cache for battery parameters (refreshed every 60 seconds)
var batteryCache = null;
var batteryCacheExpiry = 0;

// ============================================================================
// MODULE INITIALIZATION
// ============================================================================

// Ensure exports object exists (for OVMS compatibility)
if (typeof exports === 'undefined') {
    var exports = {};
}

// ============================================================================
// BATTERY DETECTION
// ============================================================================

/**
 * Get battery parameters from vehicle metrics or cache
 * Auto-detects capacity from CAC and voltage, SOH from vehicle metrics
 * Falls back to sensible defaults if metrics unavailable
 */
function getBatteryParams() {
    var now = Date.now();

    // Return cached values if still fresh
    if (batteryCache && now < batteryCacheExpiry) {
        return batteryCache;
    }

    var capacity = config.batteryCapacityKWh;
    var soh = config.batterySOH;

    try {
        // Try to detect battery capacity from CAC (Capacity Amp-Hours)
        if (!capacity && OvmsMetrics.HasValue("v.b.cac")) {
            var cac = OvmsMetrics.AsFloat("v.b.cac");
            var voltage = 360; // Default nominal voltage

            // Get actual pack voltage if available
            if (OvmsMetrics.HasValue("v.b.voltage")) {
                voltage = OvmsMetrics.AsFloat("v.b.voltage");
            } else if (OvmsMetrics.HasValue("xnl.v.b.voltage.max")) {
                voltage = OvmsMetrics.AsFloat("xnl.v.b.voltage.max");
            }

            capacity = (cac * voltage) / 1000;
        }

        // Try to detect State of Health
        if (!soh && OvmsMetrics.HasValue("v.b.soh")) {
            soh = OvmsMetrics.AsFloat("v.b.soh");
        }
    } catch (e) {
        print("Battery detection error: " + e.message + "\n");
    }

    // Fallback defaults
    if (!capacity || capacity < 10 || capacity > 250) {
        capacity = 40; // Reasonable mid-size EV default
    }
    if (!soh || soh < 50 || soh > 100) {
        soh = 100; // Assume healthy battery
    }

    var result = {
        capacity: capacity,
        soh: soh,
        usable: capacity * (soh / 100)
    };

    // Cache for 60 seconds
    batteryCache = result;
    batteryCacheExpiry = now + 60000;

    return result;
}

// ============================================================================
// STATUS & INFORMATION
// ============================================================================

/**
 * Display complete charging system status
 */
exports.status = function() {
    // Build status message
    var msg = "=== OVMS Smart Charging Status ===\n";
    msg += "Time: " + new Date().toISOString() + "\n\n";

    // Battery information
    var battery = getBatteryParams();
    msg += "Battery:\n";
    msg += "  Capacity: " + battery.capacity.toFixed(1) + " kWh\n";
    msg += "  Health: " + battery.soh.toFixed(0) + "%\n";
    msg += "  Usable: " + battery.usable.toFixed(1) + " kWh\n";
    msg += "  Charge rate: " + config.chargeRateKW + " kW\n\n";

    // Schedule information
    msg += "Schedule:\n";
    var ws = config.cheapWindowStart;
    var we = config.cheapWindowEnd;
    msg += "  Cheap rate: " + pad(ws.hour) + ":" + pad(ws.minute) +
          " to " + pad(we.hour) + ":" + pad(we.minute) + "\n";

    if (config.readyBy) {
        msg += "  Mode: Ready By " + pad(config.readyBy.hour) + ":" + pad(config.readyBy.minute) + "\n";
        var optimal = calculateOptimalStart();
        if (optimal) {
            msg += "  Optimal start: " + pad(optimal.hour) + ":" + pad(optimal.minute) + "\n";
            msg += "  Charge time: " + optimal.hoursNeeded.toFixed(1) + " hours\n";
        }
    } else {
        msg += "  Mode: Fixed schedule\n";
        msg += "  Starts: " + pad(ws.hour) + ":" + pad(ws.minute) + "\n";
        msg += "  Stops: " + pad(we.hour) + ":" + pad(we.minute) + "\n";
    }

    msg += "  Target SOC: " + config.targetSOC + "%\n";
    msg += "  Skip if above: " + config.skipIfAbove + "%\n\n";

    // Vehicle status
    msg += "Vehicle:\n";
    var soc = getSafeMetric("v.b.soc", 0);
    var charging = getSafeMetric("v.c.charging", false);
    var state = getSafeMetric("v.c.state", "unknown");
    var plugged = getSafeMetric("v.c.pilot", false);
    var temp = getSafeMetric("v.b.temp", null);

    msg += "  SOC: " + soc.toFixed(0) + "%\n";
    msg += "  Charging: " + charging + "\n";
    msg += "  State: " + state + "\n";
    msg += "  Plugged in: " + plugged + "\n";
    if (temp !== null) {
        msg += "  Battery temp: " + temp.toFixed(0) + " C\n";
    }

    msg += "\nReady to charge: " + canCharge() + "\n";

    // Output to console
    print(msg);

    // Send notification to OVMS Connect
    safeNotify("info", "charge.status", msg);
};

/**
 * Quick status showing next charge session
 */
exports.nextCharge = function() {
    var now = new Date();
    var nextStart = calculateNextStart(now);
    var stopTime = calculateStopTime(nextStart);
    var soc = getSafeMetric("v.b.soc", 0);

    var msg = "Next: " + formatTime(nextStart) + " to " + formatTime(stopTime) +
              ", SOC " + soc.toFixed(0) + "% to " + config.targetSOC + "%";

    print(msg + "\n");
    safeNotify("info", "charge.schedule", msg);
};

// ============================================================================
// CHARGING CONTROL
// ============================================================================

/**
 * Start charging with safety checks
 */
exports.start = function() {
    print("=== Starting Charge ===\n");

    // Safety checks
    if (!canCharge()) {
        var reason = getChargeBlockReason();
        print("Cannot start: " + reason + "\n");
        safeNotify("alert", "charge.manual", "Cannot start: " + reason);
        return false;
    }

    var soc = getSafeMetric("v.b.soc", 0);
    print("Current SOC: " + soc.toFixed(0) + "%\n");

    try {
        var result = OvmsCommand.Exec("charge start");
        print("Result: " + result + "\n");

        // Validate command result
        if (result && (result.toLowerCase().indexOf("error") !== -1 ||
                       result.toLowerCase().indexOf("fail") !== -1)) {
            print("Command returned error status\n");
            safeNotify("alert", "charge.manual", "Start command failed: " + result);
            return false;
        }

        safeNotify("info", "charge.manual", "Charging started at " + soc.toFixed(0) + "%");

        // Schedule automatic stop
        scheduleStop();
        return true;
    } catch (e) {
        print("Error: " + e.message + "\n");
        safeNotify("alert", "charge.manual", "Start failed: " + e.message);
        return false;
    }
};

/**
 * Stop charging
 */
exports.stop = function() {
    print("=== Stopping Charge ===\n");

    var charging = getSafeMetric("v.c.charging", false);
    if (!charging) {
        print("Not charging\n");
        safeNotify("info", "charge.manual", "Not currently charging");
        return true;
    }

    var soc = getSafeMetric("v.b.soc", 0);
    print("Final SOC: " + soc.toFixed(0) + "%\n");

    try {
        var result = OvmsCommand.Exec("charge stop");
        print("Result: " + result + "\n");

        // Validate command result
        if (result && (result.toLowerCase().indexOf("error") !== -1 ||
                       result.toLowerCase().indexOf("fail") !== -1)) {
            print("Command returned error status\n");
            safeNotify("alert", "charge.manual", "Stop command failed: " + result);
            return false;
        }

        safeNotify("info", "charge.manual", "Stopped at " + soc.toFixed(0) + "%");
        return true;
    } catch (e) {
        print("Error: " + e.message + "\n");
        safeNotify("alert", "charge.manual", "Stop failed: " + e.message);
        return false;
    }
};

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Set charging SOC limits
 */
exports.setLimits = function(target, skipIfAbove) {
    if (target < 20 || target > 100 || skipIfAbove < 10 || skipIfAbove > 100) {
        safeNotify("alert", "charge.config", "Invalid SOC values");
        return;
    }

    config.targetSOC = target;
    config.skipIfAbove = skipIfAbove;
    invalidateBatteryCache(); // Recalculate timing with new target

    var msg = "Target " + target + "%, skip if above " + skipIfAbove + "%";
    print(msg + "\n");
    safeNotify("info", "charge.config", msg);
};

/**
 * Set charger power rating
 */
exports.setChargeRate = function(rateKW) {
    if (rateKW < 1 || rateKW > 350) {
        safeNotify("alert", "charge.config", "Invalid charge rate");
        return;
    }

    config.chargeRateKW = rateKW;
    invalidateBatteryCache(); // Recalculate timing with new rate

    var type = rateKW < 2.5 ? "granny" : rateKW < 4 ? "Type 2 slow" :
               rateKW < 10 ? "Type 2 fast" : "rapid";
    var msg = "Charge rate: " + rateKW + " kW (" + type + ")";
    print(msg + "\n");
    safeNotify("info", "charge.config", msg);
};

/**
 * Set ready-by time for intelligent scheduling
 */
exports.setReadyBy = function(hour, minute) {
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        safeNotify("alert", "charge.config", "Invalid time");
        return;
    }

    config.readyBy = { hour: hour, minute: minute };

    var optimal = calculateOptimalStart();
    if (optimal) {
        var msg = "Ready by " + pad(hour) + ":" + pad(minute) +
                  ", start " + pad(optimal.hour) + ":" + pad(optimal.minute);
        print(msg + "\n");
        print("Charge time needed: " + optimal.hoursNeeded.toFixed(1) + " hours\n");
        safeNotify("info", "charge.config", msg);
    } else {
        safeNotify("alert", "charge.config", "Cannot calculate - check settings");
    }
};

/**
 * Clear ready-by, return to fixed schedule
 */
exports.clearReadyBy = function() {
    config.readyBy = null;

    var ws = config.cheapWindowStart;
    var we = config.cheapWindowEnd;
    var msg = "Fixed: " + pad(ws.hour) + ":" + pad(ws.minute) +
              " to " + pad(we.hour) + ":" + pad(we.minute);
    print(msg + "\n");
    safeNotify("info", "charge.config", msg);
};

/**
 * Set automated charging schedule times
 * User-friendly way to configure start/stop without editing files
 */
exports.setSchedule = function(startHour, startMin, stopHour, stopMin) {
    if (startHour < 0 || startHour > 23 || stopHour < 0 || stopHour > 23 ||
        startMin < 0 || startMin > 59 || stopMin < 0 || stopMin > 59) {
        safeNotify("alert", "charge.config", "Invalid time values");
        return;
    }

    config.cheapWindowStart = { hour: startHour, minute: startMin };
    config.cheapWindowEnd = { hour: stopHour, minute: stopMin };

    var msg = "Schedule: " + pad(startHour) + ":" + pad(startMin) +
              " to " + pad(stopHour) + ":" + pad(stopMin);
    print(msg + "\n");
    safeNotify("info", "charge.config", msg);
};

/**
 * Display current schedule configuration
 */
exports.getSchedule = function() {
    var ws = config.cheapWindowStart;
    var we = config.cheapWindowEnd;

    var msg = "Charging Schedule:\n";
    msg += "  Start: " + pad(ws.hour) + ":" + pad(ws.minute) + "\n";
    msg += "  Stop: " + pad(we.hour) + ":" + pad(we.minute) + "\n";

    if (config.readyBy) {
        msg += "  Mode: Ready By " + pad(config.readyBy.hour) + ":" + pad(config.readyBy.minute);
    } else {
        msg += "  Mode: Fixed schedule";
    }

    print(msg + "\n");
    safeNotify("info", "charge.config", msg);
};

/**
 * Automated check - call this from a periodic clock event
 * Checks current time and starts/stops charging as needed
 */
exports.checkSchedule = function() {
    var now = new Date();
    var currentMinutes = now.getHours() * 60 + now.getMinutes();

    var ws = config.cheapWindowStart;
    var we = config.cheapWindowEnd;
    var startMinutes = ws.hour * 60 + ws.minute;
    var stopMinutes = we.hour * 60 + we.minute;

    var charging = getSafeMetric("v.c.charging", false);
    var plugged = getSafeMetric("v.c.pilot", false);

    // Handle overnight schedules (e.g., 23:30 to 05:30)
    var inWindow = false;
    if (startMinutes > stopMinutes) {
        // Overnight: 23:30 to 05:30
        inWindow = (currentMinutes >= startMinutes || currentMinutes < stopMinutes);
    } else {
        // Same day: 10:00 to 14:00
        inWindow = (currentMinutes >= startMinutes && currentMinutes < stopMinutes);
    }

    // Decide what to do
    if (inWindow && !charging && plugged) {
        // In charging window, plugged in, not charging - try to start
        var soc = getSafeMetric("v.b.soc", 0);
        if (soc < config.skipIfAbove) {
            print("Auto-start: In charging window (" + pad(ws.hour) + ":" + pad(ws.minute) +
                  " to " + pad(we.hour) + ":" + pad(we.minute) + ")\n");
            exports.start();
        }
    } else if (!inWindow && charging) {
        // Outside charging window but still charging - stop
        print("Auto-stop: Outside charging window\n");
        exports.stop();
    }
};

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

/**
 * Invalidate battery parameter cache
 */
function invalidateBatteryCache() {
    batteryCache = null;
    batteryCacheExpiry = 0;
}

/**
 * Check if vehicle can charge right now
 */
function canCharge() {
    if (!getSafeMetric("v.c.pilot", false)) return false;
    if (getSafeMetric("v.c.charging", false)) return false;

    var soc = getSafeMetric("v.b.soc", 0);
    if (soc < config.minSOCToCharge || soc >= config.skipIfAbove) return false;

    return true;
}

/**
 * Get human-readable reason why charging is blocked
 */
function getChargeBlockReason() {
    if (!getSafeMetric("v.c.pilot", false)) return "not plugged in";
    if (getSafeMetric("v.c.charging", false)) return "already charging";

    var soc = getSafeMetric("v.b.soc", 0);
    if (soc < config.minSOCToCharge) return "SOC too low (" + soc.toFixed(0) + "%)";
    if (soc >= config.skipIfAbove) return "SOC sufficient (" + soc.toFixed(0) + "%)";

    return "unknown";
}

/**
 * Schedule automatic stop based on config
 */
function scheduleStop() {
    var now = new Date();
    var stopTime = calculateStopTime(now);

    if (stopTime <= now) {
        stopTime.setDate(stopTime.getDate() + 1);
    }

    var delayMs = stopTime.getTime() - now.getTime();
    var delayMin = delayMs / 1000 / 60;

    print("Will stop in " + delayMin.toFixed(0) + " minutes\n");
    OvmsEvents.Raise("usr.charge.stop", delayMs);
}

/**
 * Calculate optimal start time for ready-by target
 */
function calculateOptimalStart() {
    if (!config.readyBy) return null;

    var soc = getSafeMetric("v.b.soc", 0);
    var socNeeded = config.targetSOC - soc;

    if (socNeeded <= 0) return null;

    var battery = getBatteryParams();
    var kWhNeeded = (socNeeded / 100) * battery.usable;
    var hoursNeeded = kWhNeeded / config.chargeRateKW;
    var minutesNeeded = Math.ceil(hoursNeeded * 60);

    // Calculate start time working backwards from ready-by
    var now = new Date();
    var readyByTime = new Date();
    readyByTime.setHours(config.readyBy.hour, config.readyBy.minute, 0, 0);
    if (readyByTime <= now) {
        readyByTime.setDate(readyByTime.getDate() + 1);
    }

    var optimalStart = new Date(readyByTime.getTime() - (minutesNeeded * 60 * 1000));

    // Constrain to cheap rate window
    var windowStart = new Date();
    windowStart.setHours(config.cheapWindowStart.hour, config.cheapWindowStart.minute, 0, 0);
    if (windowStart <= now) {
        windowStart.setDate(windowStart.getDate() + 1);
    }

    if (optimalStart < windowStart) {
        optimalStart = windowStart; // Start at window beginning if need more time
    }

    return {
        hour: optimalStart.getHours(),
        minute: optimalStart.getMinutes(),
        hoursNeeded: hoursNeeded
    };
}

/**
 * Calculate when next charge will start
 */
function calculateNextStart(now) {
    var nextStart = new Date();

    if (config.readyBy) {
        var optimal = calculateOptimalStart();
        if (optimal) {
            nextStart.setHours(optimal.hour, optimal.minute, 0, 0);
        } else {
            nextStart.setHours(config.cheapWindowStart.hour, config.cheapWindowStart.minute, 0, 0);
        }
    } else {
        nextStart.setHours(config.cheapWindowStart.hour, config.cheapWindowStart.minute, 0, 0);
    }

    if (nextStart <= now) {
        nextStart.setDate(nextStart.getDate() + 1);
    }

    return nextStart;
}

/**
 * Calculate when charging will stop
 */
function calculateStopTime(startTime) {
    var stopTime = new Date(startTime);

    if (config.readyBy) {
        stopTime.setHours(config.readyBy.hour, config.readyBy.minute, 0, 0);
    } else {
        stopTime.setHours(config.cheapWindowEnd.hour, config.cheapWindowEnd.minute, 0, 0);
    }

    if (stopTime <= startTime) {
        stopTime.setDate(stopTime.getDate() + 1);
    }

    return stopTime;
}

/**
 * Safely get metric value with fallback
 */
function getSafeMetric(name, defaultValue) {
    try {
        if (!OvmsMetrics.HasValue(name)) return defaultValue;

        if (typeof defaultValue === "number") {
            return OvmsMetrics.AsFloat(name);
        } else if (typeof defaultValue === "boolean") {
            var val = OvmsMetrics.Value(name);
            // OVMS may return "yes"/"no", "true"/"false", or actual booleans
            return val === "yes" || val === "true" || val === true || val === 1;
        }
        return OvmsMetrics.Value(name);
    } catch (e) {
        return defaultValue;
    }
}

/**
 * Safely send notification (with graceful fallback if unavailable)
 */
function safeNotify(level, subtype, message) {
    try {
        OvmsNotify.Raise(level, subtype, message);
    } catch (e) {
        // Notification system unavailable - continue without it
    }
}

/**
 * Format time as HH:MM
 */
function formatTime(date) {
    return pad(date.getHours()) + ":" + pad(date.getMinutes());
}

/**
 * Pad number with leading zero
 */
function pad(num) {
    return num < 10 ? "0" + num : num.toString();
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

// Handle automatic stop event
PubSub.subscribe("usr.charge.stop", function(msg, data) {
    exports.stop();
});

// ============================================================================
// INITIALIZATION
// ============================================================================

var __moduleLoadTime = Date.now() - __moduleLoadStart;
print("OVMS Smart Charging v1.0 loaded (" + __moduleLoadTime + " ms)\n");
print("Type 'charging.status()' for full status\n");

// Return the exports object for module loading
// (When using require(), this makes the module's functions available)
exports;
