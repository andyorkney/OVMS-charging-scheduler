/**
 * OVMS Smart Charging Module v1.0
 * Universal charging scheduler with intelligent timing and cost optimization
 *
 * INSTALLATION:
 * 1. Save as: /store/scripts/lib/charging.js
 * 1. Add to /store/scripts/ovmsmain.js: charging = require("lib/charging");
 * 1. Create clock event files (see SETUP section below)
 * 1. Reload JS engine: Tools > Editor > "Reload JS Engine"
 *
 * FEATURES:
 * - Auto-detects battery capacity and SOH from vehicle metrics
 * - Calculates optimal charge start time for "ready by" target
 * - Works with any charge rate (granny, Type 2, rapid)
 * - Prevents charging if SOC already sufficient
 * - Notifications for all actions (OVMS Connect app)
 * - Universal - works with any OVMS-supported EV
 *
 * USAGE:
 * charging.status()                 - Show complete status
 * charging.nextCharge()              - Quick view of next charge session
 * charging.start()                   - Manual start
 * charging.stop()                    - Manual stop
 * charging.setLimits(80,75)          - Set target and skip threshold
 * charging.setChargeRate(1.8)        - Set your charger's kW rating
 * charging.setReadyBy(7,30)          - Calculate optimal start for 7:30 ready
 * charging.clearReadyBy()            - Back to fixed schedule
 *
 * SETUP:
 * Clock events trigger automatic charging. Create these files:
 *
 * /store/events/clock.2330/010-start-charge (adjust time as needed)
 * Content: script eval charging.start()
 *
 * /store/events/clock.0530/010-stop-charge (adjust time as needed)
 * Content: script eval charging.stop()
 *
 * Tip: For different start times, create different clock.HHMM folders
 */

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
    if (!capacity || capacity < 10 || capacity > 200) {
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
    OvmsNotify.Raise("info", "charge.status", msg);
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
    OvmsNotify.Raise("info", "charge.schedule", msg);
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
        OvmsNotify.Raise("alert", "charge.manual", "Cannot start: " + reason);
        return false;
    }

    var soc = getSafeMetric("v.b.soc", 0);
    print("Current SOC: " + soc.toFixed(0) + "%\n");

    try {
        var result = OvmsCommand.Exec("charge start");
        print("Result: " + result + "\n");

        OvmsNotify.Raise("info", "charge.manual", "Charging started at " + soc.toFixed(0) + "%");

        // Schedule automatic stop
        scheduleStop();
        return true;
    } catch (e) {
        print("Error: " + e.message + "\n");
        OvmsNotify.Raise("alert", "charge.manual", "Start failed: " + e.message);
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
        OvmsNotify.Raise("info", "charge.manual", "Not currently charging");
        return true;
    }

    var soc = getSafeMetric("v.b.soc", 0);
    print("Final SOC: " + soc.toFixed(0) + "%\n");

    try {
        var result = OvmsCommand.Exec("charge stop");
        print("Result: " + result + "\n");

        OvmsNotify.Raise("info", "charge.manual", "Stopped at " + soc.toFixed(0) + "%");
        return true;
    } catch (e) {
        print("Error: " + e.message + "\n");
        OvmsNotify.Raise("alert", "charge.manual", "Stop failed: " + e.message);
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
        OvmsNotify.Raise("alert", "charge.config", "Invalid SOC values");
        return;
    }

    config.targetSOC = target;
    config.skipIfAbove = skipIfAbove;

    var msg = "Target " + target + "%, skip if above " + skipIfAbove + "%";
    print(msg + "\n");
    OvmsNotify.Raise("info", "charge.config", msg);
};

/**
 * Set charger power rating
 */
exports.setChargeRate = function(rateKW) {
    if (rateKW < 1 || rateKW > 350) {
        OvmsNotify.Raise("alert", "charge.config", "Invalid charge rate");
        return;
    }

    config.chargeRateKW = rateKW;

    var type = rateKW < 2.5 ? "granny" : rateKW < 4 ? "Type 2 slow" :
               rateKW < 10 ? "Type 2 fast" : "rapid";
    var msg = "Charge rate: " + rateKW + " kW (" + type + ")";
    print(msg + "\n");
    OvmsNotify.Raise("info", "charge.config", msg);
};

/**
 * Set ready-by time for intelligent scheduling
 */
exports.setReadyBy = function(hour, minute) {
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        OvmsNotify.Raise("alert", "charge.config", "Invalid time");
        return;
    }

    config.readyBy = { hour: hour, minute: minute };

    var optimal = calculateOptimalStart();
    if (optimal) {
        var msg = "Ready by " + pad(hour) + ":" + pad(minute) +
                  ", start " + pad(optimal.hour) + ":" + pad(optimal.minute);
        print(msg + "\n");
        print("Charge time needed: " + optimal.hoursNeeded.toFixed(1) + " hours\n");
        OvmsNotify.Raise("info", "charge.config", msg);
    } else {
        OvmsNotify.Raise("alert", "charge.config", "Cannot calculate - check settings");
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
    OvmsNotify.Raise("info", "charge.config", msg);
};

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

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
        }
        return OvmsMetrics.Value(name);
    } catch (e) {
        return defaultValue;
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

print("OVMS Smart Charging v1.0 loaded\n");
print("Type 'charging.status()' for full status\n");

// Return the exports object for module loading
// (When using require(), this makes the module's functions available)
exports;
