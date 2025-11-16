/**
 * OVMS Smart Charging Scheduler - Enhanced Stable Version
 *
 * VERSION: 2.1.0-20251116-1200
 * BUILD: Added climate wake retry and vehicle wake for lock/unlock commands
 *
 * ENHANCEMENTS FROM v2.0.5.1:
 * - Climate control with intelligent wake retry
 * - Vehicle lock/unlock with pre-wake functionality
 * - Vehicle wake detection and management
 * - Configurable retry delays
 * - Enhanced session state tracking
 *
 * PREVIOUS ENHANCEMENTS (v2.0.x):
 * - Logger utility with timestamps (borrowed from ABRP)
 * - Persistent notifications ("alert" type instead of "info")
 * - Subscription state tracking (prevent duplicate subscriptions)
 * - Performance monitoring for checkSchedule()
 * - Enhanced status display with units and vehicle info
 * - Vehicle type detection
 * - UK miles conversion
 *
 * STABLE BASE:
 * - Static ticker.60 subscription (no dynamic subscribe/unsubscribe)
 * - Flag-based monitoring (session.monitoring)
 * - Minimal code, maximum stability
 *
 * USAGE:
 * charging.setSchedule(23,30,5,30)  - Set cheap window
 * charging.setLimits(80)             - Set target to 80%
 * charging.status()                  - Show detailed status
 * charging.climate("on")             - Turn climate on (with wake retry)
 * charging.lock()                    - Lock vehicle (with pre-wake)
 * charging.unlock()                  - Unlock vehicle (with pre-wake)
 */

// ============================================================================
// VERSION & MODULE INFO
// ============================================================================

var VERSION = "2.1.0-20251116-1200";

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

    return { debug: debug, error: error, info: info, log: log, warn: warn };
}

var console = logger();

console.info("OVMS Smart Charging v" + VERSION);
print(repeatString("=", 50) + "\n");

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
    targetSOC: 80,
    climateWakeRetry: true,      // Enable climate wake retry
    climateWakeDelay: 5000,      // Delay after wake (ms)
    lockWakeDelay: 3000          // Delay for lock/unlock wake (ms)
};

var session = {
    monitoring: false,           // Flag to enable/disable SOC monitoring
    subscribed: false,           // Track ticker.60 subscription state
    climateRetryPending: false,  // Climate retry in progress
    lastClimateCommand: null,    // Last climate command for retry
    climateRetryCount: 0,        // Retry attempt counter
    wakeInProgress: false,       // Vehicle wake in progress
    pendingCommand: null         // Command waiting for wake
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
 * Repeat string n times (ES5.1 compatible - no .repeat() method)
 */
function repeatString(str, count) {
    var result = "";
    for (var i = 0; i < count; i++) {
        result += str;
    }
    return result;
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
// VEHICLE WAKE MANAGEMENT
// ============================================================================

/**
 * Check if vehicle is awake
 */
function isVehicleAwake() {
    var awake = getMetric("v.e.awake", false);
    var current12v = getMetric("v.b.12v.current", 0);

    // Consider awake if flag is set OR 12V system shows activity
    return awake || current12v > 0.5;
}

/**
 * Send vehicle wake command
 */
function wakeVehicle() {
    try {
        OvmsCommand.Exec("vehicle wakeup");
        session.wakeInProgress = true;
        console.info("Vehicle wake command sent");
        return true;
    } catch (e) {
        console.error("Vehicle wake failed", e);
        return false;
    }
}

/**
 * Schedule a command to run after wake delay
 * Uses setTimeout-like behavior via ticker subscription
 */
var pendingTimers = [];
var timerCounter = 0;

function scheduleAfterDelay(callback, delayMs) {
    var timerId = ++timerCounter;
    var executeTime = Date.now() + delayMs;

    pendingTimers.push({
        id: timerId,
        callback: callback,
        executeTime: executeTime
    });

    console.info("Scheduled callback after " + delayMs + "ms (timer " + timerId + ")");
    return timerId;
}

/**
 * Process pending timers - called by ticker
 */
function processPendingTimers() {
    var now = Date.now();
    var remaining = [];

    for (var i = 0; i < pendingTimers.length; i++) {
        var timer = pendingTimers[i];
        if (now >= timer.executeTime) {
            console.info("Executing scheduled callback (timer " + timer.id + ")");
            try {
                timer.callback();
            } catch (e) {
                console.error("Scheduled callback failed", e);
            }
        } else {
            remaining.push(timer);
        }
    }

    pendingTimers = remaining;
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
        // Process any pending timers (for wake retry callbacks)
        processPendingTimers();

        // Only monitor charging if flag is set
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
    var startTime = Date.now();  // Performance monitoring (ES5.1 compatible)

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
        var duration = Date.now() - startTime;
        if (duration > 500) {
            console.warn("checkSchedule took " + duration + " ms");
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

// ============================================================================
// CLIMATE CONTROL WITH WAKE RETRY
// ============================================================================

/**
 * Execute climate command with wake retry on failure
 * @param {string} mode - "on", "off", "heat", "cool"
 */
exports.climate = function(mode) {
    if (!mode) {
        console.error("Climate: mode required (on/off/heat/cool)");
        return false;
    }

    mode = mode.toLowerCase();
    var validModes = ["on", "off", "heat", "cool"];
    if (validModes.indexOf(mode) === -1) {
        console.error("Climate: invalid mode '" + mode + "' (use on/off/heat/cool)");
        return false;
    }

    console.info("Climate control: " + mode);

    // Attempt climate command
    var success = attemptClimateCommand(mode);

    if (success) {
        console.info("Climate " + mode + " command sent successfully");
        try {
            OvmsNotify.Raise("alert", "climate.command.success",
                "Climate " + mode + " activated");
        } catch (e) {
            // Notification optional
        }
        return true;
    }

    // If failed and wake retry enabled, try waking vehicle first
    if (config.climateWakeRetry && session.climateRetryCount < 1) {
        console.info("Climate command failed, attempting vehicle wake for retry");
        session.lastClimateCommand = mode;
        session.climateRetryPending = true;
        session.climateRetryCount++;

        wakeVehicle();

        // Schedule retry after wake delay
        scheduleAfterDelay(function() {
            retryClimateCommand();
        }, config.climateWakeDelay);

        try {
            OvmsNotify.Raise("alert", "climate.wake.retry",
                "Climate " + mode + " failed, waking vehicle for retry");
        } catch (e) {
            // Notification optional
        }

        return "pending"; // Async operation
    }

    console.error("Climate " + mode + " command failed");
    session.climateRetryCount = 0;
    return false;
};

/**
 * Attempt to execute climate command
 */
function attemptClimateCommand(mode) {
    try {
        var cmd = "";
        switch (mode) {
            case "on":
                cmd = "climatecontrol on";
                break;
            case "off":
                cmd = "climatecontrol off";
                break;
            case "heat":
                cmd = "climatecontrol heat";
                break;
            case "cool":
                cmd = "climatecontrol cool";
                break;
            default:
                return false;
        }

        OvmsCommand.Exec(cmd);
        return true;
    } catch (e) {
        console.error("Climate command execution failed", e);
        return false;
    }
}

/**
 * Retry climate command after wake
 */
function retryClimateCommand() {
    if (!session.climateRetryPending || !session.lastClimateCommand) {
        console.warn("Climate retry: no pending command");
        return;
    }

    console.info("Climate retry: attempting " + session.lastClimateCommand + " after wake");

    var success = attemptClimateCommand(session.lastClimateCommand);

    if (success) {
        console.info("Climate retry successful");
        try {
            OvmsNotify.Raise("alert", "climate.retry.success",
                "Climate " + session.lastClimateCommand + " activated after wake");
        } catch (e) {
            // Notification optional
        }
    } else {
        console.error("Climate retry failed");
        try {
            OvmsNotify.Raise("alert", "climate.retry.failed",
                "Climate " + session.lastClimateCommand + " failed after wake retry");
        } catch (e) {
            // Notification optional
        }
    }

    // Reset retry state
    session.climateRetryPending = false;
    session.lastClimateCommand = null;
    session.climateRetryCount = 0;
    session.wakeInProgress = false;
}

/**
 * Show climate status
 */
exports.climateStatus = function() {
    print("\nClimate Control Status\n");
    print(repeatString("=", 50) + "\n");
    print("  Wake Retry Enabled: " + (config.climateWakeRetry ? "Yes" : "No") + "\n");
    print("  Wake Delay: " + config.climateWakeDelay + " ms\n");
    print("  Retry Pending: " + (session.climateRetryPending ? "Yes" : "No") + "\n");
    if (session.lastClimateCommand) {
        print("  Last Command: " + session.lastClimateCommand + "\n");
    }
    print("  Retry Count: " + session.climateRetryCount + "\n");
    print("\n");
};

/**
 * Configure climate wake retry
 */
exports.setClimateRetry = function(enabled) {
    config.climateWakeRetry = !!enabled;
    console.info("Climate wake retry: " + (config.climateWakeRetry ? "enabled" : "disabled"));
    return true;
};

/**
 * Set wake delay for climate retry
 */
exports.setWakeDelay = function(ms) {
    if (ms < 1000 || ms > 30000) {
        console.error("Invalid wake delay: " + ms + " (must be 1000-30000 ms)");
        return false;
    }
    config.climateWakeDelay = ms;
    console.info("Climate wake delay set: " + ms + " ms");
    return true;
};

// ============================================================================
// VEHICLE LOCK/UNLOCK WITH PRE-WAKE
// ============================================================================

/**
 * Lock vehicle with pre-wake if needed
 */
exports.lock = function() {
    return executeWithWake("lock", function() {
        OvmsCommand.Exec("lock");
    });
};

/**
 * Unlock vehicle with pre-wake if needed
 */
exports.unlock = function() {
    return executeWithWake("unlock", function() {
        OvmsCommand.Exec("unlock");
    });
};

/**
 * Execute command with vehicle wake if not awake
 */
function executeWithWake(commandName, commandFn) {
    var awake = isVehicleAwake();

    if (!awake) {
        console.info(commandName + ": Vehicle sleeping, initiating wake");
        wakeVehicle();

        // Schedule command after wake delay
        scheduleAfterDelay(function() {
            try {
                commandFn();
                console.info(commandName + ": Command sent after wake");
                try {
                    OvmsNotify.Raise("alert", "security." + commandName + ".success",
                        "Vehicle " + commandName + " command sent after wake");
                } catch (e) {
                    // Notification optional
                }
            } catch (e) {
                console.error(commandName + " failed after wake", e);
                try {
                    OvmsNotify.Raise("alert", "security." + commandName + ".failed",
                        "Vehicle " + commandName + " failed after wake");
                } catch (e2) {
                    // Notification optional
                }
            }
            session.wakeInProgress = false;
        }, config.lockWakeDelay);

        try {
            OvmsNotify.Raise("alert", "security.wake.initiated",
                commandName + " pending: waking vehicle");
        } catch (e) {
            // Notification optional
        }

        return "pending";
    }

    // Vehicle is awake, execute immediately
    try {
        commandFn();
        console.info(commandName + ": Command sent successfully");
        try {
            OvmsNotify.Raise("alert", "security." + commandName + ".success",
                "Vehicle " + commandName + " command sent");
        } catch (e) {
            // Notification optional
        }
        return true;
    } catch (e) {
        console.error(commandName + " failed", e);
        return false;
    }
}

/**
 * Show security status
 */
exports.securityStatus = function() {
    print("\nSecurity Command Status\n");
    print(repeatString("=", 50) + "\n");
    print("  Vehicle Awake: " + (isVehicleAwake() ? "Yes" : "No") + "\n");
    print("  Lock Wake Delay: " + config.lockWakeDelay + " ms\n");
    print("  Wake In Progress: " + (session.wakeInProgress ? "Yes" : "No") + "\n");
    if (session.pendingCommand) {
        print("  Pending Command: " + session.pendingCommand + "\n");
    }
    print("\n");
};

/**
 * Enhanced status display with units and vehicle info
 */
exports.status = function() {
    print("\n");
    print("OVMS Smart Charging v" + VERSION + "\n");
    print(repeatString("=", 50) + "\n");

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
    print(repeatString("=", 50) + "\n");
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
    print(repeatString("=", 50) + "\n");

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
print(repeatString("=", 50) + "\n\n");
