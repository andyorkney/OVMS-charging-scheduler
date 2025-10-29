/**
 * OVMS Smart Charging - Event Installer
 *
 * This script creates 48 clock events (every 30 minutes) that check the charging schedule.
 *
 * INSTALLATION VIA WEB EDITOR:
 * 1. Open OVMS web interface → Tools → Editor
 * 2. Create new file: /store/scripts/setup-events.js
 * 3. Copy this entire file content
 * 4. Save the file
 * 5. Go to Tools → Shell
 * 6. At the OVMS shell prompt, enter this command:
 *    script eval require("setup-events").install()
 * 7. Wait for "Installation complete!" message
 *
 * INSTALLATION VIA SSH:
 * 1. scp setup-events.js root@<your-ovms-ip>:/store/scripts/
 * 2. SSH to OVMS: ssh root@<your-ovms-ip>
 * 3. At the OVMS shell prompt, enter this command:
 *    script eval require("setup-events").install()
 *
 * VERIFICATION:
 * vfs ls /store/events/
 * You should see 48 directories: clock.0000, clock.0030, clock.0100, ..., clock.2330
 *
 * REMOVAL:
 * To uninstall, enter this command:
 * script eval require("setup-events").uninstall()
 */

// ============================================================================
// INSTALLATION FUNCTIONS
// ============================================================================

/**
 * Install clock events for automatic charging schedule checks
 */
function install() {
    print("\n=== OVMS Smart Charging Event Installer ===\n\n");

    var eventContent = "script eval charging.checkSchedule()";
    var created = 0;
    var errors = 0;

    print("Creating clock events for every 30 minutes (48 total)...\n\n");

    // Create events for every 30 minutes (00 and 30 minutes of each hour)
    for (var hour = 0; hour < 24; hour++) {
        var hours = [0, 30];

        for (var i = 0; i < hours.length; i++) {
            var minute = hours[i];

            // Format: clock.HHMM (e.g., clock.0000, clock.0030, clock.0100)
            var hourStr = (hour < 10) ? "0" + hour : "" + hour;
            var minStr = (minute < 10) ? "0" + minute : "" + minute;
            var dirName = "clock." + hourStr + minStr;
            var dirPath = "/store/events/" + dirName;
            var filePath = dirPath + "/charging-check";

            try {
                // VFS.Save automatically creates missing directories
                VFS.Save({
                    path: filePath,
                    data: eventContent
                });

                created++;
                print("✓ Created: " + dirName + "/charging-check\n");

            } catch (e) {
                errors++;
                print("✗ Error creating " + dirName + ": " + e.message + "\n");
            }
        }
    }

    print("\n=== Installation Summary ===\n");
    print("Events created: " + created + "\n");
    print("Errors: " + errors + "\n\n");

    if (errors === 0) {
        print("✓ Installation complete!\n\n");
        print("Your charging module will now check the schedule every 30 minutes.\n");
        print("Next steps:\n");
        print("  1. Configure your schedule: charging.setSchedule(23, 30, 5, 30)\n");
        print("  2. Set charge limits: charging.setLimits(80, 75)\n");
        print("  3. Check status: charging.status()\n\n");
    } else {
        print("⚠ Installation completed with errors.\n");
        print("Some events may not have been created.\n");
        print("You can try running the install command again.\n\n");
    }
}

/**
 * Uninstall clock events (cleanup)
 */
function uninstall() {
    print("\n=== OVMS Smart Charging Event Uninstaller ===\n\n");
    print("⚠ WARNING: This will remove all charging-check event files!\n");
    print("Proceeding with removal...\n\n");

    var removed = 0;
    var errors = 0;

    // Remove events for every 30 minutes
    for (var hour = 0; hour < 24; hour++) {
        var hours = [0, 30];

        for (var i = 0; i < hours.length; i++) {
            var minute = hours[i];

            var hourStr = (hour < 10) ? "0" + hour : "" + hour;
            var minStr = (minute < 10) ? "0" + minute : "" + minute;
            var dirName = "clock." + hourStr + minStr;
            var filePath = "/store/events/" + dirName + "/charging-check";

            try {
                // Remove event file using vfs command
                var result = OvmsCommand.Exec("vfs rm " + filePath);

                // Check if command succeeded (file not found is okay)
                if (result && result.indexOf("Error") !== -1 &&
                    result.indexOf("not found") === -1 &&
                    result.indexOf("No such") === -1) {
                    errors++;
                    print("✗ Error removing " + dirName + ": " + result + "\n");
                } else {
                    removed++;
                    print("✓ Removed: " + dirName + "/charging-check\n");
                }
            } catch (e) {
                errors++;
                print("✗ Error removing " + dirName + ": " + e.message + "\n");
            }

            // Note: We don't remove the directories themselves as they might contain
            // other event files. Use "vfs rmdir /store/events/clock.HHMM" manually if needed.
        }
    }

    print("\n=== Uninstallation Summary ===\n");
    print("Events removed: " + removed + "\n");
    print("Errors: " + errors + "\n\n");

    if (errors === 0) {
        print("✓ Uninstallation complete!\n");
        print("Note: Empty clock.HHMM directories were left in place.\n");
        print("They won't cause any issues, but you can remove them manually if desired.\n\n");
    } else {
        print("⚠ Uninstallation completed with errors.\n\n");
    }
}

/**
 * List all installed charging events
 */
function listEvents() {
    print("\n=== Installed Charging Events ===\n\n");

    var found = 0;

    for (var hour = 0; hour < 24; hour++) {
        var hours = [0, 30];

        for (var i = 0; i < hours.length; i++) {
            var minute = hours[i];

            var hourStr = (hour < 10) ? "0" + hour : "" + hour;
            var minStr = (minute < 10) ? "0" + minute : "" + minute;
            var dirName = "clock." + hourStr + minStr;
            var filePath = "/store/events/" + dirName + "/charging-check";

            // Check if file exists using vfs stat command
            var result = OvmsCommand.Exec("vfs stat " + filePath);

            // If stat succeeds, the file exists (no "Error" in output)
            if (result && result.indexOf("Error") === -1 && result.indexOf("not found") === -1) {
                found++;

                // Format time nicely (e.g., 00:00, 01:30, 23:30)
                var timeStr = hourStr + ":" + minStr;
                print("✓ " + timeStr + " - " + dirName + "/charging-check\n");
            }
        }
    }

    print("\nTotal events found: " + found + " / 48\n");

    if (found === 0) {
        print("\n⚠ No events installed. Run the install command to create them.\n");
    } else if (found < 48) {
        print("\n⚠ Some events are missing. Run the install command to create them.\n");
    } else {
        print("\n✓ All events are installed correctly!\n");
    }

    print("\n");
}

/**
 * Show help information
 */
function help() {
    print("\n=== OVMS Smart Charging Event Setup ===\n\n");
    print("This module creates clock events that check your charging schedule\n");
    print("every 30 minutes (48 events total: 00:00, 00:30, 01:00, ..., 23:30)\n\n");

    print("Available commands:\n");
    print("  require('setup-events').install()     - Create all clock events\n");
    print("  require('setup-events').uninstall()   - Remove all clock events\n");
    print("  require('setup-events').listEvents()  - Show installed events\n");
    print("  require('setup-events').help()        - Show this help\n\n");

    print("Example workflow:\n");
    print("  1. script eval require('setup-events').install()        # Create events\n");
    print("  2. script eval charging.setSchedule(23, 30, 5, 30)      # Configure schedule\n");
    print("  3. script eval charging.setLimits(80, 75)               # Set SOC targets\n");
    print("  4. script eval charging.status()                        # Check status\n");
    print("  5. script eval require('setup-events').listEvents()     # Verify installation\n\n");

    print("Need to modify frequency?\n");
    print("  - Every 15 minutes: Modify this script (change hours array)\n");
    print("  - Every hour: Remove events for :30 minutes\n");
    print("  - Custom times: Create individual events manually\n\n");
}

// ============================================================================
// EXPORTS
// ============================================================================

exports.install = install;
exports.uninstall = uninstall;
exports.listEvents = listEvents;
exports.help = help;

print("OVMS Charging Event Installer loaded\n");
print("Run: require('setup-events').install() to create 48 clock events\n");
print("Help: require('setup-events').help() for more information\n");

exports;
