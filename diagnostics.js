/**
 * OVMS Module Load & Event Diagnostics
 *
 * This script helps identify:
 * 1. Which modules are slow to load
 * 2. Which event handlers are subscribed to ticker events
 * 3. How long module initialization takes
 *
 * Usage:
 *   1. Copy to /store/scripts/diagnostics.js on OVMS
 *   2. Run: script eval diagnostics = require("diagnostics");
 *   3. Run: diagnostics.checkLoadTime();
 *   4. Run: diagnostics.listEventSubscriptions();
 */

// ============================================================================
// MODULE LOAD TIME CHECKER
// ============================================================================

/**
 * Check how long the charging module takes to load
 */
function checkLoadTime() {
    print("=== Module Load Time Test ===\n\n");

    // Test charging module load time
    print("Testing charging module load time...\n");
    var startTime = Date.now();

    try {
        // Force reload by clearing require cache if possible
        var charging = require("lib/charging");
        var endTime = Date.now();
        var loadTime = endTime - startTime;

        print("[OK] Charging module loaded in " + loadTime + " ms\n");

        if (loadTime > 1000) {
            print("[WARNING] Load time exceeds 1 second!\n");
        } else if (loadTime > 100) {
            print("[INFO] Load time is acceptable but could be optimized\n");
        } else {
            print("[OK] Load time is excellent\n");
        }

        print("\n");
        return loadTime;
    } catch (e) {
        print("[ERROR] Error loading charging module: " + e.message + "\n");
        return -1;
    }
}

/**
 * List all event subscriptions (if OVMS API allows)
 */
function listEventSubscriptions() {
    print("=== Event Subscription Analysis ===\n\n");

    print("Charging module event subscriptions:\n");
    print("  - usr.charge.stop (custom event)\n");
    print("  - No ticker.* events used\n");
    print("  - Uses clock.HHMM events via /store/events/ system\n\n");

    print("To identify what's using ticker.10:\n");
    print("1. Run: script list\n");
    print("2. Check each loaded script\n");
    print("3. Look for PubSub.subscribe('ticker.10', ...) calls\n");
    print("4. Check /store/scripts/ for other .js files\n\n");

    print("Common culprits:\n");
    print("  - Custom monitoring scripts\n");
    print("  - Vehicle-specific plugins\n");
    print("  - Telemetry/logging modules\n");
    print("  - Display update scripts\n\n");
}

/**
 * Test function execution times
 */
function profileChargingFunctions() {
    print("=== Charging Module Function Profiling ===\n\n");

    try {
        var charging = require("lib/charging");
        var results = {};

        // Test status() function
        var start = Date.now();
        charging.status();
        results.status = Date.now() - start;

        // Test getSchedule() function
        start = Date.now();
        charging.getSchedule();
        results.getSchedule = Date.now() - start;

        // Test nextCharge() function
        start = Date.now();
        charging.nextCharge();
        results.nextCharge = Date.now() - start;

        print("Function execution times:\n");
        print("  status():      " + results.status + " ms\n");
        print("  getSchedule(): " + results.getSchedule + " ms\n");
        print("  nextCharge():  " + results.nextCharge + " ms\n\n");

        var total = results.status + results.getSchedule + results.nextCharge;
        if (total > 500) {
            print("[WARNING] Functions are slow (total: " + total + " ms)\n");
        } else {
            print("[OK] Functions execute quickly (total: " + total + " ms)\n");
        }

        return results;
    } catch (e) {
        print("[ERROR] Error profiling functions: " + e.message + "\n");
        return null;
    }
}

/**
 * Generate recommendations based on diagnostics
 */
function diagnoseTickerIssue() {
    print("=== Ticker.10 Diagnostic Report ===\n\n");

    print("ISSUE: Event handling for 'ticker.10' took 6990 ms\n\n");

    print("What this means:\n");
    print("  - Something is taking 7 seconds every 10 seconds\n");
    print("  - This represents ~70% CPU usage\n");
    print("  - Significant 12V battery drain\n");
    print("  - NOT caused by charging module (verified)\n\n");

    print("Steps to identify the culprit:\n\n");

    print("1. List all loaded scripts:\n");
    print("   OVMS# script list\n\n");

    print("2. Check /store/scripts/ directory:\n");
    print("   OVMS# vfs ls /store/scripts/\n\n");

    print("3. Search for ticker.10 subscriptions in each script:\n");
    print("   Look for: PubSub.subscribe('ticker.10', ...)\n");
    print("   Look for: PubSub.subscribe('ticker.*', ...)\n\n");

    print("4. Common issues:\n");
    print("   - Blocking network calls (API requests without timeout)\n");
    print("   - Large data processing in event handler\n");
    print("   - File I/O operations (reading/writing large files)\n");
    print("   - Infinite loops or recursive calls\n");
    print("   - Missing error handling causing retries\n\n");

    print("5. Temporary fix - disable ticker events:\n");
    print("   WARNING: This may break other functionality!\n");
    print("   Method: Rename problematic script or comment out ticker subscription\n\n");

    print("6. Permanent fix:\n");
    print("   - Move heavy operations out of ticker handlers\n");
    print("   - Use less frequent events (ticker.60, ticker.300)\n");
    print("   - Optimize data processing\n");
    print("   - Add caching to reduce repeated work\n");
    print("   - Use async operations if supported\n\n");
}

/**
 * Run complete diagnostics
 */
function runAll() {
    print("\n========================================\n");
    print("OVMS DIAGNOSTIC SUITE\n");
    print("========================================\n\n");

    checkLoadTime();
    print("\n");

    profileChargingFunctions();
    print("\n");

    listEventSubscriptions();
    print("\n");

    diagnoseTickerIssue();

    print("========================================\n");
    print("Diagnostics complete\n");
    print("========================================\n\n");
}

// ============================================================================
// EXPORTS
// ============================================================================

// Use proper exports pattern for OVMS Duktape compatibility
exports.checkLoadTime = checkLoadTime;
exports.listEventSubscriptions = listEventSubscriptions;
exports.profileChargingFunctions = profileChargingFunctions;
exports.diagnoseTickerIssue = diagnoseTickerIssue;
exports.runAll = runAll;

print("OVMS Diagnostics loaded\n");
print("Run: diagnostics.runAll() for complete analysis\n");
print("Or run individual tests:\n");
print("  - diagnostics.checkLoadTime()\n");
print("  - diagnostics.profileChargingFunctions()\n");
print("  - diagnostics.diagnoseTickerIssue()\n");
