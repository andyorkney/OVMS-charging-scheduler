/**
 * OVMS Smart Charging Scheduler - Enhanced Stable Version
 *
 * VERSION: 2.0.5.1-20251110-1930
 * BUILD: Fixed unreliable Leaf instrument metrics, added UK miles conversion
 *
 * ENHANCEMENTS FROM v2.0.4:
 * - Logger utility with timestamps (borrowed from ABRP)
 * - Persistent notifications ("alert" type instead of "info")
 * - Nissan Leaf specific SOC metric (xnl.v.b.soc.instrument)
 * - Subscription state tracking (prevent duplicate subscriptions)
 * - Performance monitoring for checkSchedule()
 * - Enhanced status display with units and vehicle info
 * - Vehicle type detection
 *
 * STABLE BASE FROM v2.0.3/2.0.4:
 * - Static ticker.60 subscription (no dynamic subscribe/unsubscribe)
 * - Flag-based monitoring (session.monitoring)
 * - Minimal code, maximum stability
 *
 * USAGE:
 * charging.setSchedule(23,30,5,30)  - Set cheap window
 * charging.setLimits(80)             - Set target to 80%
 * charging.status()                  - Show detailed status
 * charging.info()                    - Show metrics (ABRP style)
 */

// ============================================================================
// VERSION & MODULE INFO
// ============================================================================

const VERSION = "2.0.5.1-20251110-1930";

if (typeof exports === 'undefined') {
    var exports = {};
}

// ============================================================================
// LOGGER UTILITY (borrowed from ABRP.js)
// ============================================================================

function timestamp() {
    return new Date().toLocaleString();
}

function logger() {
    function log(message, obj) {
        print(message + (obj ? ' ' + JSON.stringify(obj) : '') + '\n');
    }

    function debug(message, obj) {
        // Debug disabled by default - enable for troubleshooting
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

    return { debug, error, info, log, warn };
}

const console = logger();

console.info("OVMS Smart Charging v" + VERSION);
print("=".repeat(50) + "\n");

// ============================================================================
// VEHICLE TYPE DETECTION
// ============================================================================

var vehicleType = "";
try {
    vehicleType = OvmsMetrics.Value('v.type') || "";
} catch (e) {
    vehicleType = "";
}

// ============================================================================
// CONFIGURATION
// ============================================================================

var config = {
    cheapWindowStart: { hour: 23, minute: 30 },
    cheapWindowEnd: { hour: 5, minute: 30 },
    targetSOC: 80
};

var session = {
    monitoring: false,  // Flag to enable/disable SOC monitoring
    subscribed: false   // Track ticker.60 subscription state
};

// ============================================================================
// PERSISTENCE
// ============================================================================

function loadConfig() {
    try {
        var target = OvmsConfig.Get("usr", "charging.target.soc");
        if (target && target !== "") {
            var t = parseInt(target);
            if (!isNaN(t) && t >= 20 && t <= 100) {
                config.targetSOC = t;
            }
        }

        var sh = OvmsConfig.Get("usr", "charging.window.start.hour");
        if (sh && sh !== "") {
            config.cheapWindowStart.hour = parseInt(sh);
            config.cheapWindowStart.minute = parseInt(OvmsConfig.Get("usr", "charging.window.start.minute") || "0");
            config.cheapWindowEnd.hour = parseInt(OvmsConfig.Get("usr", "charging.window.end.hour") || "0");
            config.cheapWindowEnd.minute = parseInt(OvmsConfig.Get("usr", "charging.window.end.minute") || "0");
        }
    } catch (e) {
        console.error("Load config failed", e);
    }
}

function saveValue(key, value) {
    try {
        OvmsConfig.Set("usr", key, value.toString());
    } catch (e) {
        console.error("Save value failed: " + key, e);
    }
}

// ============================================================================
// UTILITIES
// ============================================================================

function pad(n) {
    return n < 10 ? "0" + n : n.toString();
}

/**
 * Get metric with vehicle-specific handling (borrowed from ABRP pattern)
 */
function getMetric(name, def) {
    try {
        return OvmsMetrics.HasValue(name) ? OvmsMetrics.AsFloat(name) : def;
    } catch (e) {
        return def;
    }
}

/**
 * Convert km to miles for UK users
 */
function kmToMiles(km) {
    return km * 0.621371;
}

/**
 * Get SOC - Use standard metric (Leaf instrument unreliable after sleep/reboot)
 */
function getSOC() {
    // Use standard SOC - proven reliable in v2.0.4
    // Leaf instrument metrics (xnl.v.b.soc.instrument) are unreliable after sleep
    return getMetric('v.b.soc', 0);
}

/**
 * Get SOH - Use standard metric, return null if 0 (not yet available)
 */
function getSOH() {
    var soh = getMetric('v.b.soh', 0);
    // Return null if 0 (not available yet after sleep/reboot)
    return soh > 0 ? soh : null;
}

// ============================================================================
// CHARGING CONTROL
// ============================================================================

exports.start = function() {
    var soc = getSOC();
    var plugged = getMetric("v.c.pilot", false);

    if (!plugged) {
        console.warn("Start failed: Not plugged in");
        return false;
    }

    if (soc >= config.targetSOC) {
        console.info("Start skipped: Already at target (" + soc.toFixed(0) + "%)");
        return false;
    }

    try {
        session.monitoring = true;
        OvmsCommand.Exec("charge start");
        console.info("Charging started: " + soc.toFixed(0) + "% → " + config.targetSOC + "%");

        // Notify OVMS app (persistent notification)
        try {
            OvmsNotify.Raise("alert", "charge.smart.started",
                "Smart charging: " + soc.toFixed(0) + "% → " + config.targetSOC + "%");
        } catch (e) {
            console.error("Notification failed", e);
        }

        return true;
    } catch (e) {
        console.error("Start charging failed", e);
        return false;
    }
};

exports.stop = function() {
    try {
        session.monitoring = false;
        OvmsCommand.Exec("charge stop");
        console.info("Charging stopped");
        return true;
    } catch (e) {
        console.error("Stop charging failed", e);
        return false;
    }
};

// ============================================================================
// MONITORING - Called by ticker.60 (subscribed once at startup)
// ============================================================================

function monitorSOC() {
    try {
        // Only monitor if flag is set
        if (!session.monitoring) {
            return;
        }

        var charging = getMetric("v.c.charging", false);
        if (!charging) {
            console.info("Monitor: Charging stopped externally");
            session.monitoring = false;
            return;
        }

        var soc = getSOC();

        // Log every check for debugging
        console.info("Monitor: SOC=" + soc.toFixed(1) + "% Target=" + config.targetSOC + "%");

        // Check target
        if (soc >= config.targetSOC) {
            console.info("Target reached: " + soc.toFixed(1) + "% (target " + config.targetSOC + "%)");

            // Notify OVMS app (persistent notification)
            try {
                OvmsNotify.Raise("alert", "charge.smart.stopped",
                    "Target reached: " + soc.toFixed(0) + "% (target " + config.targetSOC + "%)");
            } catch (e) {
                console.error("Notification failed", e);
            }

            exports.stop();
        }
    } catch (e) {
        console.error("Monitor failed", e);
    }
}

// ============================================================================
// SCHEDULING
// ============================================================================

exports.checkSchedule = function() {
    var startTime = performance.now();  // Performance monitoring

    try {
        var now = new Date();
        var min = now.getHours() * 60 + now.getMinutes();

        var soc = getSOC();
        var charging = getMetric("v.c.charging", false);
        var plugged = getMetric("v.c.pilot", false);

        var startMin = config.cheapWindowStart.hour * 60 + config.cheapWindowStart.minute;
        var endMin = config.cheapWindowEnd.hour * 60 + config.cheapWindowEnd.minute;

        var inWindow = (startMin > endMin) ?
            (min >= startMin || min < endMin) :
            (min >= startMin && min < endMin);

        // Auto-start in window
        if (inWindow && !charging && plugged && soc < config.targetSOC) {
            console.info("Schedule: Auto-start triggered");
            exports.start();
        }
        // Auto-stop outside window
        else if (!inWindow && charging) {
            console.info("Schedule: Auto-stop triggered (outside window)");
            exports.stop();
        }
    } catch (e) {
        console.error("checkSchedule failed", e);
    } finally {
        // Performance warning if slow
        var duration = performance.now() - startTime;
        if (duration > 500) {
            console.warn("checkSchedule took " + duration.toFixed(0) + " ms");
        }
    }
};

// ============================================================================
// USER COMMANDS
// ============================================================================

exports.setSchedule = function(sh, sm, eh, em) {
    config.cheapWindowStart = { hour: sh, minute: sm };
    config.cheapWindowEnd = { hour: eh, minute: em };

    saveValue("charging.window.start.hour", sh);
    saveValue("charging.window.start.minute", sm);
    saveValue("charging.window.end.hour", eh);
    saveValue("charging.window.end.minute", em);

    console.info("Window set: " + pad(sh) + ":" + pad(sm) + " to " + pad(eh) + ":" + pad(em));
    return true;
};

exports.setLimits = function(target) {
    if (target < 20 || target > 100) {
        console.error("Invalid target: " + target + " (must be 20-100%)");
        return false;
    }

    config.targetSOC = target;
    saveValue("charging.target.soc", target);

    console.info("Target set: " + target + "%");
    return true;
};

/**
 * Enhanced status display with units and vehicle info
 */
exports.status = function() {
    print("\n");
    print("OVMS Smart Charging v" + VERSION + "\n");
    print("=".repeat(50) + "\n");

    // Schedule
    print("Schedule:\n");
    print("  Cheap window: " + pad(config.cheapWindowStart.hour) + ":" +
          pad(config.cheapWindowStart.minute) + " to " +
          pad(config.cheapWindowEnd.hour) + ":" + pad(config.cheapWindowEnd.minute) + "\n");
    print("  Target SOC: " + config.targetSOC + " %\n");

    // Vehicle state
    var soc = getSOC();
    var charging = getMetric("v.c.charging", false);
    var plugged = getMetric("v.c.pilot", false);
    var power = getMetric("v.c.power", 0);
    var voltage = getMetric("v.b.voltage", 0);
    var temp = getMetric("v.b.temp", null);
    var rangeKm = getMetric("v.b.range.est", 0);
    var rangeMiles = kmToMiles(rangeKm);
    var soh = getSOH();

    print("\nVehicle:\n");
    print("  State of Charge: " + soc.toFixed(1) + " %\n");
    print("  Charging: " + (charging ? "Yes" : "No") + "\n");
    print("  Plugged In: " + (plugged ? "Yes" : "No") + "\n");
    if (charging && power > 0) {
        print("  Charge Power: " + power.toFixed(2) + " kW\n");
    }
    print("  Battery Voltage: " + voltage.toFixed(1) + " V\n");
    if (temp !== null) {
        print("  Battery Temp: " + temp.toFixed(0) + " °C\n");
    }
    print("  Est. Range: " + rangeMiles.toFixed(0) + " miles (" + rangeKm.toFixed(0) + " km)\n");
    if (soh !== null) {
        print("  State of Health: " + soh.toFixed(0) + " %\n");
    }

    if (vehicleType) {
        print("  Vehicle Type: " + vehicleType + "\n");
    }

    print("\n");
};

/**
 * Debug - show internal state
 */
exports.debug = function() {
    print("\nDEBUG - Internal State\n");
    print("=".repeat(50) + "\n");
    print("session.monitoring: " + session.monitoring + "\n");
    print("session.subscribed: " + session.subscribed + "\n");
    print("config.targetSOC: " + config.targetSOC + "\n");
    print("Current SOC: " + getSOC().toFixed(1) + "%\n");
    print("Charging: " + getMetric("v.c.charging", false) + "\n");
    print("Plugged: " + getMetric("v.c.pilot", false) + "\n");
    print("\n");
};

/**
 * Info display (ABRP style) - shows raw metrics
 */
exports.info = function() {
    print("\n");
    print("OVMS Smart Charging Metrics v" + VERSION + "\n");
    print("=".repeat(50) + "\n");

    function showMetric(label, value, unit) {
        unit = unit || '';
        print(label + ": " + value + " " + unit + "\n");
    }

    var rangeKm = getMetric("v.b.range.est", 0);
    var odometerKm = getMetric("v.p.odometer", 0);
    var soh = getSOH();

    showMetric("UTC Timestamp", Math.floor(Date.now() / 1000), "s");
    showMetric("State of Charge", getSOC().toFixed(1), "%");
    showMetric("Battery Power", getMetric("v.b.power", 0).toFixed(2), "kW");
    showMetric("Charging", getMetric("v.c.charging", false) ? "true" : "false");
    showMetric("Plugged In", getMetric("v.c.pilot", false) ? "true" : "false");
    showMetric("Battery Voltage", getMetric("v.b.voltage", 0).toFixed(1), "V");
    showMetric("Battery Current", getMetric("v.b.current", 0).toFixed(1), "A");
    showMetric("Battery Temp", getMetric("v.b.temp", 0).toFixed(0), "°C");
    if (soh !== null) {
        showMetric("State of Health", soh.toFixed(0), "%");
    }
    showMetric("Estimated Range", kmToMiles(rangeKm).toFixed(0) + " miles (" + rangeKm.toFixed(0) + " km)");
    showMetric("Odometer", kmToMiles(odometerKm).toFixed(1) + " miles (" + odometerKm.toFixed(1) + " km)");
    if (vehicleType) {
        showMetric("Vehicle Type", vehicleType);
    }

    print("\n");
};

// ============================================================================
// INITIALIZATION
// ============================================================================

loadConfig();

// Subscribe ticker.60 ONCE at startup (not dynamically)
// Track subscription state to prevent duplicates
if (!session.subscribed) {
    PubSub.subscribe("ticker.60", monitorSOC);
    session.subscribed = true;
    console.info("Subscribed to ticker.60");
}

console.info("Config loaded - Target: " + config.targetSOC + "%");
console.info("Ready for operation");
print("=".repeat(50) + "\n\n");
