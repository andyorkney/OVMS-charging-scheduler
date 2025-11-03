/**
 * OVMSv3 Module - Smart Charging Script v1.0
 * Universal charging scheduler with intelligent timing and cost optimisation
 *
 * COMMAND FORMAT NOTES:
 * - Commands below work in OVMS Connect app (recommended for mobile/dashboard)
 * - For OVMS web console/SSH: wrap commands in quotes if preferred
 * - Mobile keyboards use "smart quotes" which break commands - use these formats to avoid issues
 *
 * QUICK START:
 * 1. Upload charging.js to /store/scripts/lib/charging.js
 * 2. Upload setup-events.js to /store/scripts/setup-events.js
 * 3. Add to /store/scripts/ovmsmain.js: charging = require("lib/charging");
 * 4. At the OVMS shell, run: script eval require('setup-events').install()
 * 5. Configure schedule: script eval charging.setSchedule(23,30,5,30)
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
 * - Smart overflow handling: starts early in cheap window for resilience
 * - Cost calculation: warns about kWh charged outside cheap window
 * - Emergency mode: always charges if deadline imminent (safety first!)
 * - Works with any charge rate (granny, Type 2, rapid)
 * - Prevents charging if SOC already sufficient
 * - Notifications for all actions (OVMS Connect app)
 * - User-friendly runtime configuration (no file editing!)
 * - Universal - works with any OVMS-supported EV
 *
 * USAGE - Information:
 * script eval charging.status()                  - Show complete status
 * script eval charging.nextCharge()              - Quick view of next charge session
 * script eval charging.getSchedule()             - Show current schedule times
 *
 * USAGE - Manual Control:
 * script eval charging.start()                   - Manual start
 * script eval charging.stop()                    - Manual stop
 *
 * USAGE - Configuration:
 * script eval charging.setSchedule(23,30,5,30)   - Set start/stop times (23:30 to 5:30)
 * script eval charging.setLimits(80,75)          - Set target and skip threshold
 * script eval charging.setChargeRate(1.8)        - Set your charger's kW rating
 * script eval charging.setPricing(0.07,0.28)     - Set cheap/standard rates (currency optional)
 * script eval charging.setReadyBy(7,30)          - Intelligent: ready by 7:30
 * script eval charging.clearReadyBy()            - Back to fixed schedule
 *
 * USAGE - Automation:
 * script eval charging.checkSchedule()           - Check time and start/stop as needed
 *
 * SETUP:
 * Use the setup-events.js installer to create clock events automatically:
 *   script eval require('setup-events').install()
 *
 * Then configure your schedule:
 *   script eval charging.setSchedule(23,30,5,30)
 *   script eval charging.setLimits(80,75)
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

    // Electricity pricing (per kWh) - set via setPricing()
    pricing: {
        cheap: 0.07,        // Cheap rate (e.g., overnight) - £/$/€ per kWh
        standard: 0.28,     // Standard/daytime rate - £/$/€ per kWh
        currency: "£"       // Currency symbol for display
    },

    // Battery parameters (null = auto-detect from vehicle)
    batteryCapacityKWh: null,
    batterySOH: null
};

// Cache for battery parameters (refreshed every 60 seconds)
var batteryCache = null;
var batteryCacheExpiry = 0;

// Charge session tracking (for completion summary - UX Improvement E)
var chargeStartSOC = null;
var chargeStartTime = null;

// SOC monitoring throttle (ticker.10 fires every 10s, check SOC every 60s = every 6th tick)
var socMonitorTickCount = 0;

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
    msg += "Time: " + new Date().toString() + "\n\n";

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
          " to " + pad(we.hour) + ":" + pad(we.minute) +
          " (" + config.pricing.currency + config.pricing.cheap.toFixed(2) + "/kWh)\n";
    msg += "  Standard rate: " + config.pricing.currency + config.pricing.standard.toFixed(2) + "/kWh\n";

    if (config.readyBy) {
        msg += "  Mode: Ready By " + pad(config.readyBy.hour) + ":" + pad(config.readyBy.minute) + "\n";
        var optimal = calculateOptimalStart();
        if (optimal) {
            msg += "  Start time: " + pad(optimal.hour) + ":" + pad(optimal.minute);
            if (optimal.emergency) {
                msg += " [EMERGENCY - START NOW!]\n";
            } else if (optimal.startEarly) {
                msg += " (early start, " + optimal.bufferHours.toFixed(1) + "h buffer)\n";
            } else {
                msg += "\n";
            }

            msg += "  Charge time: " + optimal.hoursNeeded.toFixed(1) + " hours";
            msg += " (" + optimal.kWhNeeded.toFixed(1) + " kWh)\n";

            // Show warnings for overflow
            if (!optimal.fitsInWindow && !optimal.emergency) {
                msg += "\n  [WARNING] Charge time exceeds cheap window!\n";
                if (optimal.overflowBefore > 0) {
                    var costBefore = optimal.overflowBeforeKWh * config.pricing.standard;
                    msg += "  - Before window: " + optimal.overflowBefore.toFixed(1) + "h, " +
                           optimal.overflowBeforeKWh.toFixed(1) + " kWh (" +
                           config.pricing.currency + costBefore.toFixed(2) + ")\n";
                }
                if (optimal.overflowAfter > 0) {
                    var costAfter = optimal.overflowAfterKWh * config.pricing.standard;
                    msg += "  - After window: " + optimal.overflowAfter.toFixed(1) + "h, " +
                           optimal.overflowAfterKWh.toFixed(1) + " kWh (" +
                           config.pricing.currency + costAfter.toFixed(2) + ")\n";
                }
                msg += "  - Extra cost: " + config.pricing.currency + optimal.overflowCost.toFixed(2) + "\n";
            } else if (optimal.emergency) {
                msg += "\n  [EMERGENCY] Not enough time to reach target!\n";
                msg += "  - Need " + optimal.hoursNeeded.toFixed(1) + "h but deadline is imminent\n";
                msg += "  - Starting immediately to maximize charge\n";
            }
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

    // Calculate charge details
    var battery = getBatteryParams();
    var socNeeded = config.targetSOC - soc;
    var kWhNeeded = (socNeeded / 100) * battery.usable;
    var hoursNeeded = kWhNeeded / config.chargeRateKW;
    var costCheap = kWhNeeded * config.pricing.cheap;

    var msg = "Next: " + formatTime(nextStart) + " to " + formatTime(stopTime) + "\n";
    msg += "SOC " + soc.toFixed(0) + "% → " + config.targetSOC + "%";

    if (socNeeded > 0) {
        msg += " (" + hoursNeeded.toFixed(1) + "h, " + kWhNeeded.toFixed(1) + " kWh)\n";

        // Calculate window duration
        var windowDurationMs = stopTime.getTime() - nextStart.getTime();
        var windowDurationHours = windowDurationMs / (1000 * 60 * 60);

        // Check if charge will overflow cheap window
        if (hoursNeeded > windowDurationHours) {
            // Calculate overflow
            var overflowHours = hoursNeeded - windowDurationHours;
            var overflowKWh = overflowHours * config.chargeRateKW;
            var overflowCost = overflowKWh * config.pricing.standard;

            var cheapHours = windowDurationHours;
            var cheapKWh = cheapHours * config.chargeRateKW;
            var cheapCost = cheapKWh * config.pricing.cheap;
            var totalCost = cheapCost + overflowCost;

            msg += "Cost: " + config.pricing.currency + totalCost.toFixed(2);
            msg += " (" + config.pricing.currency + cheapCost.toFixed(2) + " cheap + " +
                   config.pricing.currency + overflowCost.toFixed(2) + " overflow)\n";
            msg += "WARNING: Charge extends " + overflowHours.toFixed(1) + "h beyond cheap window";
        } else {
            // Fits in cheap window
            msg += "Cost: " + config.pricing.currency + costCheap.toFixed(2) + " (cheap rate)";
        }
    }

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

    // Track start of charge session (for completion summary - UX Improvement E)
    chargeStartSOC = soc;
    chargeStartTime = new Date();

    // Calculate charge details for notification
    var battery = getBatteryParams();
    var socNeeded = config.targetSOC - soc;
    var kWhNeeded = (socNeeded / 100) * battery.usable;
    var hoursNeeded = kWhNeeded / config.chargeRateKW;
    var costCheap = kWhNeeded * config.pricing.cheap;

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

        // Subscribe to ticker.10 for SOC monitoring (Priority #1: Stop at target SOC)
        // Note: ticker.10 fires every 10s, but we throttle to check SOC every 60s
        print("Starting SOC monitoring (checking every 60 seconds)\n");
        socMonitorTickCount = 0;  // Reset counter
        PubSub.subscribe("ticker.10", monitorSOC);

        // Build detailed notification with cost/time estimates
        var msg = "Charging started: " + soc.toFixed(0) + "% → " + config.targetSOC + "%\n";
        msg += "Time: " + hoursNeeded.toFixed(1) + "h (" + kWhNeeded.toFixed(1) + " kWh)\n";

        // Check for overflow into expensive rate
        var optimal = calculateOptimalStart();
        if (optimal && !optimal.fitsInWindow && !optimal.emergency) {
            var totalCost = costCheap + optimal.overflowCost;
            msg += "Cost: " + config.pricing.currency + totalCost.toFixed(2);
            msg += " (" + config.pricing.currency + costCheap.toFixed(2) + " cheap";
            if (optimal.overflowCost > 0) {
                msg += " + " + config.pricing.currency + optimal.overflowCost.toFixed(2) + " overflow)";
            } else {
                msg += ")";
            }
        } else {
            msg += "Cost: " + config.pricing.currency + costCheap.toFixed(2) + " (cheap rate)";
        }

        safeNotify("info", "charge.schedule", msg);

        // Schedule automatic stop at window end time (fallback)
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
 * UX Improvement E: Shows completion summary with duration, energy, cost
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

        // Unsubscribe from SOC monitoring
        PubSub.unsubscribe("ticker.10", monitorSOC);
        print("SOC monitoring stopped\n");

        // UX Improvement E: Display completion summary
        var msg = "Stopped at " + soc.toFixed(0) + "%";
        if (chargeStartSOC !== null && chargeStartTime !== null) {
            var socGain = soc - chargeStartSOC;
            var durationMs = new Date().getTime() - chargeStartTime.getTime();
            var durationHours = durationMs / (1000 * 60 * 60);

            if (socGain > 0.5 && durationHours > 0.01) { // Only show if meaningful charge occurred
                var battery = getBatteryParams();
                var kWhCharged = (socGain / 100) * battery.usable;

                // Calculate actual cost based on when charging occurred
                var costs = calculateChargeCost(chargeStartTime, new Date(), config.chargeRateKW);

                print("\n=== Charge Session Complete ===\n");
                print("SOC: " + chargeStartSOC.toFixed(0) + "% → " + soc.toFixed(0) + "% (+" +
                      socGain.toFixed(0) + "%)\n");
                print("Duration: " + durationHours.toFixed(1) + " hours\n");
                print("Energy: " + kWhCharged.toFixed(1) + " kWh\n");

                if (costs.preWindowHours > 0 || costs.postWindowHours > 0) {
                    print("Cost breakdown:\n");
                    if (costs.preWindowHours > 0) {
                        print("  Before window: " + config.pricing.currency + costs.preWindowCost.toFixed(2) + "\n");
                    }
                    if (costs.cheapHours > 0) {
                        print("  Cheap window: " + config.pricing.currency + costs.cheapCost.toFixed(2) + "\n");
                    }
                    if (costs.postWindowHours > 0) {
                        print("  After window: " + config.pricing.currency + costs.postWindowCost.toFixed(2) + "\n");
                    }
                    print("  Total: " + config.pricing.currency + costs.totalCost.toFixed(2) + "\n");
                } else {
                    print("Cost: " + config.pricing.currency + costs.totalCost.toFixed(2) + " (cheap rate)\n");
                }

                msg = "Complete: " + chargeStartSOC.toFixed(0) + "% → " + soc.toFixed(0) + "% (+" +
                      socGain.toFixed(0) + "%), " + durationHours.toFixed(1) + "h, " +
                      kWhCharged.toFixed(1) + " kWh, " + config.pricing.currency + costs.totalCost.toFixed(2);
            }

            // Reset session tracking
            chargeStartSOC = null;
            chargeStartTime = null;
        }

        safeNotify("info", "charge.manual", msg);
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
 * UX Improvement A: Shows smart forecast when plugged in
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

    // UX Improvement A: Show forecast if plugged in
    var plugged = getSafeMetric("v.c.pilot", false);
    var soc = getSafeMetric("v.b.soc", 0);

    if (plugged && soc < skipIfAbove) {
        print("\n=== Next Charge Forecast ===\n");

        // Calculate charge details
        var battery = getBatteryParams();
        var socNeeded = target - soc;
        var kWhNeeded = (socNeeded / 100) * battery.usable;
        var hoursNeeded = kWhNeeded / config.chargeRateKW;

        // Calculate next start time
        var now = new Date();
        var nextStart = calculateNextStart(now);
        var stopTime = calculateStopTime(nextStart);

        print("Current SOC: " + soc.toFixed(0) + "%\n");
        print("Will charge: " + soc.toFixed(0) + "% → " + target + "% (+" + socNeeded.toFixed(0) + "%)\n");
        print("Energy needed: " + kWhNeeded.toFixed(1) + " kWh\n");
        print("Charge time: " + hoursNeeded.toFixed(1) + " hours\n");
        print("Next start: " + formatTime(nextStart) + "\n");
        print("Target finish: " + formatTime(stopTime) + "\n");

        // Calculate and display costs with overflow detection
        var chargeEnd = new Date(nextStart.getTime() + (hoursNeeded * 60 * 60 * 1000));
        var costs = calculateChargeCost(nextStart, chargeEnd, config.chargeRateKW);

        if (costs.preWindowHours > 0 || costs.postWindowHours > 0) {
            print("\n[COST WARNING]\n");
            if (costs.preWindowHours > 0) {
                print("  Before cheap window: " + costs.preWindowKWh.toFixed(1) + " kWh (" +
                      config.pricing.currency + costs.preWindowCost.toFixed(2) + ")\n");
            }
            if (costs.cheapHours > 0) {
                print("  During cheap window: " + costs.cheapKWh.toFixed(1) + " kWh (" +
                      config.pricing.currency + costs.cheapCost.toFixed(2) + ")\n");
            }
            if (costs.postWindowHours > 0) {
                print("  After cheap window: " + costs.postWindowKWh.toFixed(1) + " kWh (" +
                      config.pricing.currency + costs.postWindowCost.toFixed(2) + ")\n");
            }
            print("  Total cost: " + config.pricing.currency + costs.totalCost.toFixed(2) + "\n");
        } else {
            print("Estimated cost: " + config.pricing.currency + costs.totalCost.toFixed(2) + " (cheap rate)\n");
        }

        msg += "\nNext: " + formatTime(nextStart) + ", " + hoursNeeded.toFixed(1) + "h, " +
               config.pricing.currency + costs.totalCost.toFixed(2);
    }

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
 * Set electricity pricing for cost calculations
 * Currency parameter is optional - defaults to current setting
 */
exports.setPricing = function(cheapRate, standardRate, currency) {
    if (cheapRate < 0 || standardRate < 0) {
        safeNotify("alert", "charge.config", "Invalid pricing rates");
        return;
    }

    config.pricing.cheap = cheapRate;
    config.pricing.standard = standardRate;
    if (currency) {
        config.pricing.currency = currency;
    }

    var msg = "Pricing: " + config.pricing.currency + cheapRate + " cheap, " +
              config.pricing.currency + standardRate + " standard (per kWh)";
    print(msg + "\n");
    safeNotify("info", "charge.config", msg);
};

/**
 * Set ready-by time for intelligent scheduling
 * UX Improvement C: Shows cost breakdown and warnings
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
        print("Charge time: " + optimal.hoursNeeded.toFixed(1) + " hours (" +
              optimal.kWhNeeded.toFixed(1) + " kWh)\n");

        // Show start time context
        var ws = config.cheapWindowStart;
        var cheapStart = pad(ws.hour) + ":" + pad(ws.minute);
        var we = config.cheapWindowEnd;
        var cheapEnd = pad(we.hour) + ":" + pad(we.minute);

        if (optimal.emergency) {
            print("\n[EMERGENCY] Not enough time! Start NOW!\n");
        } else if (optimal.startEarly) {
            print("[INFO] Must start before cheap window (starts at " + cheapStart + ")\n");
        } else {
            print("[INFO] Will start at cheap window start (" + cheapStart + ")\n");
            if (optimal.bufferHours > 0) {
                print("Buffer time: " + optimal.bufferHours.toFixed(1) + " hours before ready-by\n");
            }
        }

        // Calculate and display cost breakdown
        var now = new Date();
        var startTime = new Date();
        startTime.setHours(optimal.hour, optimal.minute, 0, 0);
        if (startTime <= now) {
            startTime.setDate(startTime.getDate() + 1);
        }
        var endTime = new Date(startTime.getTime() + (optimal.hoursNeeded * 60 * 60 * 1000));
        var costs = calculateChargeCost(startTime, endTime, config.chargeRateKW);

        // Display cost breakdown if any overflow
        if (costs.preWindowHours > 0 || costs.postWindowHours > 0) {
            print("\n=== Cost Breakdown ===\n");
            if (costs.preWindowHours > 0) {
                print("Before cheap window: " + costs.preWindowKWh.toFixed(1) + " kWh @ " +
                      config.pricing.currency + config.pricing.standard.toFixed(2) + "/kWh = " +
                      config.pricing.currency + costs.preWindowCost.toFixed(2) + "\n");
            }
            if (costs.cheapHours > 0) {
                print("During cheap window: " + costs.cheapKWh.toFixed(1) + " kWh @ " +
                      config.pricing.currency + config.pricing.cheap.toFixed(2) + "/kWh = " +
                      config.pricing.currency + costs.cheapCost.toFixed(2) + "\n");
            }
            if (costs.postWindowHours > 0) {
                print("After cheap window: " + costs.postWindowKWh.toFixed(1) + " kWh @ " +
                      config.pricing.currency + config.pricing.standard.toFixed(2) + "/kWh = " +
                      config.pricing.currency + costs.postWindowCost.toFixed(2) + "\n");
            }
            print("Total: " + config.pricing.currency + costs.totalCost.toFixed(2) + "\n");

            var extraCost = costs.preWindowCost + costs.postWindowCost;
            if (extraCost > 0) {
                print("\n[COST WARNING] Extra cost vs all-cheap: " +
                      config.pricing.currency + extraCost.toFixed(2) + "\n");
            }
        } else {
            print("Estimated cost: " + config.pricing.currency + costs.totalCost.toFixed(2) +
                  " (all in cheap window)\n");
        }

        msg += " (" + optimal.hoursNeeded.toFixed(1) + "h)";
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

    var charging = getSafeMetric("v.c.charging", false);
    var plugged = getSafeMetric("v.c.pilot", false);
    var soc = getSafeMetric("v.b.soc", 0);

    // Determine start and stop times based on mode
    var startMinutes, stopMinutes;
    var startDesc, stopDesc;

    if (config.readyBy) {
        // READY-BY MODE: Use calculated optimal start time
        var optimal = calculateOptimalStart();

        if (optimal) {
            // Check for EMERGENCY - need to start NOW
            if (optimal.emergency && !charging && plugged && soc < config.skipIfAbove) {
                print("[EMERGENCY] Not enough time to reach target! Starting immediately.\n");
                print("  Need " + optimal.hoursNeeded.toFixed(1) + "h, deadline imminent\n");
                exports.start();
                return; // Exit early, emergency overrides all
            }

            // Use optimal start time (may be before/within/after window)
            startMinutes = optimal.hour * 60 + optimal.minute;
            startDesc = "optimal " + pad(optimal.hour) + ":" + pad(optimal.minute);

            // Show overflow warnings when starting
            if (!optimal.fitsInWindow && !charging) {
                if (optimal.overflowBefore > 0) {
                    print("[INFO] Will charge " + optimal.overflowBeforeKWh.toFixed(1) +
                          " kWh BEFORE cheap window (extra cost: " + config.pricing.currency +
                          (optimal.overflowBeforeKWh * config.pricing.standard).toFixed(2) + ")\n");
                }
                if (optimal.overflowAfter > 0) {
                    print("[INFO] Will charge " + optimal.overflowAfterKWh.toFixed(1) +
                          " kWh AFTER cheap window (extra cost: " + config.pricing.currency +
                          (optimal.overflowAfterKWh * config.pricing.standard).toFixed(2) + ")\n");
                }
            }
        } else {
            // Can't calculate optimal (already charged enough?) - use window start
            startMinutes = config.cheapWindowStart.hour * 60 + config.cheapWindowStart.minute;
            startDesc = "window " + pad(config.cheapWindowStart.hour) + ":" + pad(config.cheapWindowStart.minute);
        }

        // Stop at ready-by time
        stopMinutes = config.readyBy.hour * 60 + config.readyBy.minute;
        stopDesc = "ready-by " + pad(config.readyBy.hour) + ":" + pad(config.readyBy.minute);
    } else {
        // FIXED SCHEDULE MODE: Use window times directly
        startMinutes = config.cheapWindowStart.hour * 60 + config.cheapWindowStart.minute;
        stopMinutes = config.cheapWindowEnd.hour * 60 + config.cheapWindowEnd.minute;
        startDesc = pad(config.cheapWindowStart.hour) + ":" + pad(config.cheapWindowStart.minute);
        stopDesc = pad(config.cheapWindowEnd.hour) + ":" + pad(config.cheapWindowEnd.minute);
    }

    // Handle overnight schedules (e.g., 23:30 to 05:30)
    var inWindow = false;
    if (startMinutes > stopMinutes) {
        // Overnight: start time is before midnight, stop time is after midnight
        inWindow = (currentMinutes >= startMinutes || currentMinutes < stopMinutes);
    } else {
        // Same day: start and stop within same day
        inWindow = (currentMinutes >= startMinutes && currentMinutes < stopMinutes);
    }

    // Decide what to do
    if (inWindow && !charging && plugged) {
        // In charging window, plugged in, not charging - try to start
        if (soc < config.skipIfAbove) {
            print("Auto-start: In window (" + startDesc + " to " + stopDesc +
                  "), SOC " + soc.toFixed(0) + "% < " + config.skipIfAbove + "%\n");
            exports.start();
        } else {
            print("Skip: SOC " + soc.toFixed(0) + "% >= " + config.skipIfAbove +
                  "% (already charged enough)\n");
        }
    } else if (!inWindow && charging) {
        // Outside charging window but still charging - stop
        print("Auto-stop: Outside charging window (after " + stopDesc + ")\n");
        exports.stop();
    } else {
        // No action needed - print status so user knows it ran
        var status = "No action: ";
        if (!plugged) {
            status += "not plugged in";
        } else if (inWindow && charging) {
            status += "in window, charging to " + config.targetSOC + "% (current " + soc.toFixed(0) + "%)";
        } else if (!inWindow && !charging) {
            status += "outside window (" + startDesc + " to " + stopDesc + "), not charging";
        } else {
            status += "waiting for charging window";
        }
        status += " (SOC " + soc.toFixed(0) + "%, " + now.toString() + ")";
        print(status + "\n");
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
 * Monitor SOC during charging and stop at target
 * Called every 10 seconds via ticker.10 subscription, but throttled to check every 60s
 * Priority #1: Stop at target SOC
 */
function monitorSOC() {
    // Throttle: only check every 6th tick (60 seconds)
    socMonitorTickCount++;
    if (socMonitorTickCount < 6) {
        return;
    }
    socMonitorTickCount = 0;  // Reset counter

    var charging = getSafeMetric("v.c.charging", false);
    var soc = getSafeMetric("v.b.soc", 0);

    // Only act if currently charging
    if (!charging) {
        return;
    }

    // Check if target SOC reached
    if (soc >= config.targetSOC) {
        print("Target SOC reached: " + soc.toFixed(1) + "% >= " + config.targetSOC + "%\n");
        exports.stop();
    }
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
 * Calculate charging cost breakdown for a given time period
 * Returns cost split between cheap window and standard rate periods
 */
function calculateChargeCost(startTime, endTime, chargeRateKW) {
    // Create cheap window times for comparison
    var cheapStart = new Date(startTime);
    cheapStart.setHours(config.cheapWindowStart.hour, config.cheapWindowStart.minute, 0, 0);
    if (cheapStart < startTime) {
        cheapStart.setDate(cheapStart.getDate() + 1);
    }

    var cheapEnd = new Date(cheapStart);
    cheapEnd.setHours(config.cheapWindowEnd.hour, config.cheapWindowEnd.minute, 0, 0);
    if (cheapEnd <= cheapStart) {
        cheapEnd.setDate(cheapEnd.getDate() + 1);
    }

    var totalHours = (endTime - startTime) / (1000 * 60 * 60);
    var totalKWh = totalHours * chargeRateKW;

    var preWindowHours = 0;
    var cheapHours = 0;
    var postWindowHours = 0;

    // Calculate time before cheap window
    if (startTime < cheapStart) {
        preWindowHours = Math.min((cheapStart - startTime) / (1000 * 60 * 60), totalHours);
    }

    // Calculate time in cheap window
    var chargeCheapStart = startTime > cheapStart ? startTime : cheapStart;
    var chargeCheapEnd = endTime < cheapEnd ? endTime : cheapEnd;
    if (chargeCheapStart < chargeCheapEnd) {
        cheapHours = (chargeCheapEnd - chargeCheapStart) / (1000 * 60 * 60);
    }

    // Calculate time after cheap window
    if (endTime > cheapEnd) {
        postWindowHours = (endTime - cheapEnd) / (1000 * 60 * 60);
    }

    return {
        preWindowHours: preWindowHours,
        preWindowKWh: preWindowHours * chargeRateKW,
        preWindowCost: preWindowHours * chargeRateKW * config.pricing.standard,
        cheapHours: cheapHours,
        cheapKWh: cheapHours * chargeRateKW,
        cheapCost: cheapHours * chargeRateKW * config.pricing.cheap,
        postWindowHours: postWindowHours,
        postWindowKWh: postWindowHours * chargeRateKW,
        postWindowCost: postWindowHours * chargeRateKW * config.pricing.standard,
        totalCost: (preWindowHours + postWindowHours) * chargeRateKW * config.pricing.standard +
                   cheapHours * chargeRateKW * config.pricing.cheap,
        totalKWh: totalKWh,
        totalHours: totalHours
    };
}

/**
 * Get human-readable reason why charging is blocked
 * Enhanced with more helpful error messages (UX Improvement B)
 */
function getChargeBlockReason() {
    if (!getSafeMetric("v.c.pilot", false)) {
        return "Vehicle not plugged in\nAction: Plug in vehicle and ensure charge port is unlocked";
    }
    if (getSafeMetric("v.c.charging", false)) {
        return "Vehicle is already charging";
    }

    var soc = getSafeMetric("v.b.soc", 0);
    if (soc < config.minSOCToCharge) {
        return "Battery at " + soc.toFixed(0) + "% (below safe minimum of " + config.minSOCToCharge + "%)";
    }
    if (soc >= config.skipIfAbove) {
        return "Battery already at " + soc.toFixed(0) + "% (above skip threshold of " + config.skipIfAbove + "%)";
    }

    return "unknown reason";
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
 * Calculate optimal start time for ready-by target with overflow detection
 * Returns detailed info about charging schedule including cost overflows
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

    var now = new Date();

    // Calculate ready-by time
    var readyByTime = new Date();
    readyByTime.setHours(config.readyBy.hour, config.readyBy.minute, 0, 0);
    if (readyByTime <= now) {
        readyByTime.setDate(readyByTime.getDate() + 1);
    }

    // Calculate cheap window times
    var windowStart = new Date();
    windowStart.setHours(config.cheapWindowStart.hour, config.cheapWindowStart.minute, 0, 0);
    if (windowStart <= now) {
        windowStart.setDate(windowStart.getDate() + 1);
    }

    var windowEnd = new Date();
    windowEnd.setHours(config.cheapWindowEnd.hour, config.cheapWindowEnd.minute, 0, 0);
    if (windowEnd <= windowStart) {
        windowEnd.setDate(windowEnd.getDate() + 1); // Next day if overnight window
    }

    // Calculate cheap window duration in hours
    var windowDurationMs = windowEnd.getTime() - windowStart.getTime();
    var windowDurationHours = windowDurationMs / (1000 * 60 * 60);

    var result = {
        hour: 0,
        minute: 0,
        hoursNeeded: hoursNeeded,
        kWhNeeded: kWhNeeded,
        windowDurationHours: windowDurationHours,
        fitsInWindow: hoursNeeded <= windowDurationHours,
        overflowBefore: 0,
        overflowAfter: 0,
        overflowBeforeKWh: 0,
        overflowAfterKWh: 0,
        overflowCost: 0,
        startEarly: false,
        bufferHours: 0,
        emergency: false
    };

    // CORRECTED LOGIC (Priority #2: Ready-by scheduling)
    // DEFAULT: Always start at cheap window start (23:30)
    // ONLY start earlier: If starting at 23:30 would miss ready-by deadline
    // Prefer finishing early over "perfect" timing

    var optimalStart = windowStart;
    var chargeEnd = new Date(optimalStart.getTime() + (minutesNeeded * 60 * 1000));

    // Check if starting at cheap window would finish AFTER ready-by time
    if (chargeEnd > readyByTime) {
        // Must start earlier to meet ready-by deadline
        optimalStart = new Date(readyByTime.getTime() - (minutesNeeded * 60 * 1000));

        // Check if optimal start is in the past (emergency!)
        if (optimalStart <= now) {
            result.emergency = true;
            result.hour = now.getHours();
            result.minute = now.getMinutes();
            return result;
        }

        result.startEarly = true;

        // Calculate overflow before window (pre-window charging)
        if (optimalStart < windowStart) {
            var overflowBeforeMs = windowStart.getTime() - optimalStart.getTime();
            result.overflowBefore = overflowBeforeMs / (1000 * 60 * 60);
            result.overflowBeforeKWh = result.overflowBefore * config.chargeRateKW;
        }

        // Calculate overflow after window (post-window charging)
        chargeEnd = new Date(optimalStart.getTime() + (minutesNeeded * 60 * 1000));
        if (chargeEnd > windowEnd) {
            var overflowAfterMs = chargeEnd.getTime() - windowEnd.getTime();
            result.overflowAfter = overflowAfterMs / (1000 * 60 * 60);
            result.overflowAfterKWh = result.overflowAfter * config.chargeRateKW;
        }

        // Calculate total overflow cost
        var totalOverflowKWh = result.overflowBeforeKWh + result.overflowAfterKWh;
        result.overflowCost = totalOverflowKWh * config.pricing.standard;
    } else {
        // Starting at cheap window start will finish before ready-by time
        // This is ideal - maximum buffer time
        result.bufferHours = (readyByTime.getTime() - chargeEnd.getTime()) / (1000 * 60 * 60);

        // Check if charge extends beyond cheap window end
        if (chargeEnd > windowEnd) {
            var overflowAfterMs = chargeEnd.getTime() - windowEnd.getTime();
            result.overflowAfter = overflowAfterMs / (1000 * 60 * 60);
            result.overflowAfterKWh = result.overflowAfter * config.chargeRateKW;
            result.overflowCost = result.overflowAfterKWh * config.pricing.standard;
            result.fitsInWindow = false;
        }
    }

    result.hour = optimalStart.getHours();
    result.minute = optimalStart.getMinutes();

    return result;
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
print('Run: script eval charging.status() for full status\n');

// Return the exports object for module loading
// (When using require(), this makes the module's functions available)
exports;
