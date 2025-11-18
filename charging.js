/**
 * OVMS Smart Charging Scheduler - v0.1.0
 *
 * VERSION: 0.1.0
 * BUILD: Minimal robust foundation with proper architecture
 *
 * CRITICAL FIXES FROM v3.5.0:
 * - Module wrapper (IIFE) for proper scoping
 * - Subscription tracking for clean management
 * - State flags to prevent event confusion
 * - Event subscriptions with state guards
 * - Init/shutdown lifecycle management
 * - Ticker.60 only (no setInterval)
 * - Robust error handling
 *
 * FEATURES:
 * - Ready-by time scheduling (reach target SOC by departure time)
 * - SOH-aware battery capacity calculations
 * - Cost estimates with cheap/standard rates
 * - Automatic schedule calculation on plug-in detection
 * - Ticker-based SOC monitoring
 *
 * ES5.1/DUKTAPE COMPATIBLE:
 * - Uses var only (no let/const)
 * - No arrow functions
 * - No template literals
 * - No modern array methods
 */

(function() {
    "use strict";

    // ========================================================================
    // VERSION & MODULE INFO
    // ========================================================================

    var VERSION = "0.1.0";

    print("\n");
    print("OVMS Smart Charging v" + VERSION + "\n");
    print("==================================================\n");

    // ========================================================================
    // UTILITIES
    // ========================================================================

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

    function log(message, level) {
        var prefix = "[" + timestamp() + "]";
        if (level === "error") {
            prefix += " ERROR:";
        } else if (level === "warn") {
            prefix += " WARN:";
        }
        print(prefix + " " + message + "\n");
    }

    // ========================================================================
    // CONFIGURATION
    // ========================================================================

    var config = {
        // Charging targets
        targetSOC: 80,
        readyByHour: 7,
        readyByMinute: 30,

        // Cheap rate window
        cheapWindowStart: { hour: 23, minute: 30 },
        cheapWindowEnd: { hour: 5, minute: 30 },

        // Electricity rates (£/kWh)
        cheapRate: 0.07,
        standardRate: 0.292,

        // Charger
        chargerRate: 1.8  // kW
    };

    // ========================================================================
    // STATE MANAGEMENT
    // ========================================================================

    var state = {
        // Charging state flags
        scheduled_charge_active: false,  // TRUE when scheduled charge running
        manual_override: false,          // TRUE when user manually started
        monitoring_active: false,        // TRUE when SOC monitoring active

        // Plug state tracking
        lastPluggedIn: false,

        // Schedule data
        scheduledStartMin: null,
        scheduledEndMin: null,
        scheduledKwhNeeded: null,
        scheduledCost: null,
        scheduledMessage: null,

        // Timer tracking
        schedule_timer: null
    };

    // ========================================================================
    // SUBSCRIPTION TRACKING
    // ========================================================================

    var subscriptions = {
        ticker: null,      // For SOC monitoring
        plugIn: null,      // For plug-in detection
        plugOut: null      // For unplug detection
    };

    // ========================================================================
    // PERSISTENCE
    // ========================================================================

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

            log("Config loaded: Target " + config.targetSOC + "%, Ready by " +
                  formatTime(config.readyByHour, config.readyByMinute));

        } catch (e) {
            log("Config load error: " + e.message, "error");
        }
    }

    function saveConfig(key, value) {
        try {
            OvmsConfig.Set("usr", key, String(value));
        } catch (e) {
            log("Config save error: " + key + " - " + e.message, "error");
        }
    }

    // ========================================================================
    // METRICS HELPERS
    // ========================================================================

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

    function validateMetrics() {
        var required = ["v.b.soc", "v.c.charging", "v.c.pilot"];
        var missing = [];
        var i;

        for (i = 0; i < required.length; i++) {
            if (!OvmsMetrics.HasValue(required[i])) {
                missing.push(required[i]);
            }
        }

        if (missing.length > 0) {
            log("WARNING: Missing metrics: " + missing.join(", "), "warn");
            return false;
        }
        return true;
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

    // ========================================================================
    // TIME CALCULATIONS
    // ========================================================================

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

    function normalizeToReference(timeMin, referenceMin) {
        if (timeMin > referenceMin) {
            return timeMin - 1440;
        }
        return timeMin;
    }

    // ========================================================================
    // SCHEDULE CALCULATION
    // ========================================================================

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
            latestStartMin += 1440;
        }

        // Determine actual start time
        var scheduledStartMin;
        var mustStartEarly = false;

        var cheapStartNormalized = normalizeToReference(cheapStartMin, readyByMin);
        var latestStartNormalized = normalizeToReference(latestStartMin, readyByMin);

        if (latestStartNormalized >= cheapStartNormalized) {
            scheduledStartMin = cheapStartMin;
        } else {
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
            var hoursUntilCheap = (cheapStartMin - scheduledStartMin + 1440) % 1440 / 60;
            if (hoursUntilCheap > hoursNeeded) {
                overspillHours = hoursNeeded;
                cheapHours = 0;
            } else {
                overspillHours = hoursUntilCheap;
                cheapHours = hoursNeeded - hoursUntilCheap;
            }
        } else {
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

    // ========================================================================
    // NOTIFICATIONS
    // ========================================================================

    function notify(message) {
        var msg = "[" + timestamp() + "] " + message;
        print(msg + "\n");

        try {
            OvmsNotify.Raise("info", "charge.smart", msg);
        } catch (e) {
            // Notification failed, but we printed to console
        }
    }

    // ========================================================================
    // EVENT SUBSCRIPTIONS
    // ========================================================================

    function subscribeToEvents() {
        log("Subscribing to vehicle events");

        // ONLY plug-in preparation, NOT charge.start (prevents event confusion)
        subscriptions.plugIn = PubSub.subscribe("vehicle.charge.prepare", onPlugIn);
        subscriptions.plugOut = PubSub.subscribe("vehicle.charge.pilot.off", onUnplug);

        // Ticker for SOC monitoring (started separately)
    }

    function unsubscribeFromEvents() {
        log("Unsubscribing from all events");

        if (subscriptions.plugIn) {
            PubSub.unsubscribe(subscriptions.plugIn);
            subscriptions.plugIn = null;
        }

        if (subscriptions.plugOut) {
            PubSub.unsubscribe(subscriptions.plugOut);
            subscriptions.plugOut = null;
        }

        stopSOCMonitoring();
    }

    // ========================================================================
    // PLUG-IN/OUT EVENT HANDLERS
    // ========================================================================

    function onPlugIn() {
        // STATE GUARD: Don't interfere with active charging
        if (state.scheduled_charge_active) {
            log("Ignoring plug-in event - scheduled charge active");
            return;
        }

        if (state.manual_override) {
            log("Ignoring plug-in event - manual charge active");
            return;
        }

        log("Vehicle plugged in - calculating schedule");

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

        // Schedule the start
        scheduleStart();
    }

    function onUnplug() {
        log("Vehicle unplugged");
        clearSchedule();
        stopSOCMonitoring();

        // Reset state flags
        state.scheduled_charge_active = false;
        state.manual_override = false;
    }

    // ========================================================================
    // SCHEDULE MANAGEMENT
    // ========================================================================

    function scheduleStart() {
        if (state.scheduledStartMin === null) {
            return;
        }

        var nowMin = getCurrentMinutes();
        var startMin = state.scheduledStartMin;

        // Calculate delay
        var delay = startMin - nowMin;
        if (delay < 0) {
            delay += 1440;  // Next day
        }

        if (delay > 720) {
            delay -= 1440;  // Actually in the past
        }

        if (delay < 0 || delay > 720) {
            log("Schedule start time invalid", "warn");
            return;
        }

        var delayMs = delay * 60 * 1000;

        log("Scheduling start in " + delay + " minutes");

        // Clear any existing timer
        if (state.schedule_timer) {
            clearTimeout(state.schedule_timer);
        }

        // Schedule the start
        state.schedule_timer = setTimeout(onScheduledStart, delayMs);
    }

    function onScheduledStart() {
        log("Scheduled start time reached");

        // Set state BEFORE any operations
        state.scheduled_charge_active = true;
        state.manual_override = false;

        // Start charging
        var success = startCharging();
        if (!success) {
            log("Failed to start scheduled charge", "error");
            state.scheduled_charge_active = false;
            return;
        }

        // Start monitoring
        startSOCMonitoring();

        notify("Charging started. Target " + config.targetSOC + "%.");
    }

    function clearSchedule() {
        if (state.schedule_timer) {
            clearTimeout(state.schedule_timer);
            state.schedule_timer = null;
        }

        state.scheduledStartMin = null;
        state.scheduledEndMin = null;
        state.scheduledKwhNeeded = null;
        state.scheduledCost = null;
        state.scheduledMessage = null;

        log("Schedule cleared");
    }

    // ========================================================================
    // SOC MONITORING (Ticker-based)
    // ========================================================================

    function startSOCMonitoring() {
        if (subscriptions.ticker) {
            log("SOC monitoring already active");
            return;
        }

        log("Starting SOC monitoring (ticker.60)");

        subscriptions.ticker = PubSub.subscribe("ticker.60", function() {
            // Only monitor if actively charging
            if (!state.scheduled_charge_active && !state.manual_override) {
                stopSOCMonitoring();
                return;
            }

            try {
                var charging = isCharging();
                var currentSOC = getSOC();

                if (!charging) {
                    log("Charging stopped externally");
                    stopSOCMonitoring();
                    state.scheduled_charge_active = false;
                    state.manual_override = false;
                    return;
                }

                log("SOC check: " + currentSOC.toFixed(1) + "% (target: " + config.targetSOC + "%)");

                if (currentSOC >= config.targetSOC) {
                    log("Target SOC reached!");
                    notify("Target reached: " + currentSOC.toFixed(0) + "%");
                    stopCharging();
                }

            } catch (e) {
                log("SOC monitoring error: " + e.message, "error");
            }
        });

        state.monitoring_active = true;
    }

    function stopSOCMonitoring() {
        if (subscriptions.ticker) {
            PubSub.unsubscribe(subscriptions.ticker);
            subscriptions.ticker = null;
            state.monitoring_active = false;
            log("SOC monitoring stopped");
        }
    }

    // ========================================================================
    // CHARGING CONTROL
    // ========================================================================

    function startCharging() {
        try {
            log("Executing: charge start");
            OvmsCommand.Exec("charge start");
            return true;
        } catch (e) {
            log("Start charging error: " + e.message, "error");
            return false;
        }
    }

    function stopCharging() {
        try {
            log("Executing: charge stop");
            OvmsCommand.Exec("charge stop");

            // Clear state
            state.scheduled_charge_active = false;
            state.manual_override = false;
            stopSOCMonitoring();

            return true;
        } catch (e) {
            log("Stop charging error: " + e.message, "error");
            return false;
        }
    }

    // ========================================================================
    // USER API
    // ========================================================================

    var api = {};

    api.setTarget = function(soc) {
        if (soc >= 20 && soc <= 100) {
            config.targetSOC = soc;
            saveConfig("charging.target.soc", soc);
            print("Target set to " + soc + "%\n");
            return "Target: " + soc + "%";
        }
        return "Error: SOC must be 20-100";
    };

    api.setReadyBy = function(hour, minute) {
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

    api.setWindow = function(startHour, startMin, endHour, endMin) {
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

    api.setRates = function(cheap, standard) {
        config.cheapRate = cheap;
        config.standardRate = standard;
        saveConfig("charging.pricing.cheap", cheap);
        saveConfig("charging.pricing.standard", standard);
        print("Rates: \u00A3" + cheap + " (cheap), \u00A3" + standard + " (standard)\n");
        return "Rates: " + cheap + "/" + standard;
    };

    api.setCharger = function(kw) {
        config.chargerRate = kw;
        saveConfig("charging.charger.rate", kw);
        print("Charger rate: " + kw + " kW\n");
        return "Charger: " + kw + " kW";
    };

    api.start = function() {
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

        // Clear any scheduled charge
        clearSchedule();

        // Set manual override flag
        state.manual_override = true;
        state.scheduled_charge_active = false;

        // Start charging
        var success = startCharging();
        if (!success) {
            state.manual_override = false;
            return "Error: Failed to start";
        }

        // Start monitoring
        startSOCMonitoring();

        return "Charging: " + soc.toFixed(0) + "% -> " + config.targetSOC + "%";
    };

    api.stop = function() {
        clearSchedule();
        stopCharging();
        return "Charging stopped";
    };

    api.status = function() {
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
        lines.push("");
        lines.push("State:");
        lines.push("  Scheduled charge: " + (state.scheduled_charge_active ? "Active" : "Inactive"));
        lines.push("  Manual override: " + (state.manual_override ? "Active" : "Inactive"));
        lines.push("  SOC monitoring: " + (state.monitoring_active ? "Active" : "Inactive"));
        lines.push("");
        lines.push("Ready by: " + formatTime(config.readyByHour, config.readyByMinute));
        lines.push("Cheap window: " + formatTime(config.cheapWindowStart.hour, config.cheapWindowStart.minute) +
                   " - " + formatTime(config.cheapWindowEnd.hour, config.cheapWindowEnd.minute));

        if (state.scheduledStartMin !== null) {
            var startTime = minutesToTime(state.scheduledStartMin);
            var endTime = minutesToTime(state.scheduledEndMin);
            lines.push("");
            lines.push("Schedule:");
            lines.push("  Start: " + formatTime(startTime.hour, startTime.minute));
            lines.push("  End: " + formatTime(endTime.hour, endTime.minute));
            lines.push("  Cost: \u00A3" + state.scheduledCost.toFixed(2));
        } else {
            lines.push("");
            lines.push("Schedule: None");
        }

        var output = lines.join("\n");
        print(output + "\n");

        try {
            OvmsNotify.Raise("info", "charge.status", output);
        } catch (e) {}

        return output;
    };

    api.shutdown = function() {
        log("Shutting down Smart Charging");
        clearSchedule();
        stopSOCMonitoring();
        unsubscribeFromEvents();
        return "Shutdown complete";
    };

    // ========================================================================
    // INITIALIZATION
    // ========================================================================

    function init() {
        log("Initializing Smart Charging v" + VERSION);

        // Load configuration
        loadConfig();

        // Validate metrics
        validateMetrics();

        // Subscribe to events
        subscribeToEvents();

        log("Initialization complete");
    }

    // ========================================================================
    // EXPORTS
    // ========================================================================

    if (typeof exports === "undefined") {
        exports = {};
    }

    exports.charging = api;

    // ========================================================================
    // START
    // ========================================================================

    init();

    print("Ready\n");

})();
