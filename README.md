# OVMS Smart Charging Module v1.0

Universal charging scheduler with intelligent timing and cost optimization for OVMS (Open Vehicle Monitoring System).

## Features

- **Auto-Detection**: Automatically detects battery capacity and State of Health (SOH) from vehicle metrics
- **Intelligent Scheduling**: Calculates optimal charge start time for "ready by" target
- **Universal Compatibility**: Works with any charge rate (granny charger, Type 2, rapid chargers)
- **Smart Prevention**: Prevents charging if State of Charge (SOC) is already sufficient
- **Notifications**: Push notifications for all actions via OVMS Connect app
- **Vehicle Agnostic**: Works with any OVMS-supported electric vehicle

## Installation

### 1. Upload the Script

Copy `charging.js` to your OVMS module:

```bash
# Via OVMS web interface:
# Tools > Editor > Upload file to /store/scripts/lib/charging.js

# Or via SCP:
scp charging.js root@<your-ovms-ip>:/store/scripts/lib/charging.js
```

### 2. Load the Module

Add this line to `/store/scripts/ovmsmain.js`:

```javascript
charging = require("lib/charging");
```

### 3. Create Clock Events

**RECOMMENDED - Easy Method:** Create automated schedule checker (set times via commands, no file editing needed):

```bash
ssh root@<your-ovms-ip>

# Create clock events that run every 30 minutes
EVENT_CONTENT="script eval charging.checkSchedule()"
for hour in {0..23}; do
    for minute in 00 30; do
        DIR="/store/events/clock.$(printf '%02d%02d' $hour $minute)"
        mkdir -p "$DIR"
        echo "$EVENT_CONTENT" > "$DIR/charging-check"
    done
done
```

Then set your charging times via command (no file editing!):
```
script eval charging.setSchedule(23, 30, 5, 30)
```

**Alternative - Manual Method:** Create specific start/stop events:

**Start charging at 23:30** (11:30 PM):
- Create directory: `/store/events/clock.2330/`
- Create file: `/store/events/clock.2330/010-start-charge`
- Content:
  ```
  script eval charging.start()
  ```

**Stop charging at 05:30** (5:30 AM):
- Create directory: `/store/events/clock.0530/`
- Create file: `/store/events/clock.0530/010-stop-charge`
- Content:
  ```
  script eval charging.stop()
  ```

### 4. Reload JS Engine

In OVMS web interface:
- Go to **Tools > Editor**
- Click **"Reload JS Engine"**

Or via command line:
```
script reload
```

## Configuration

**User-Friendly Method (Recommended):** Configure via commands - no file editing needed!

```bash
# Set charging schedule (start at 23:30, stop at 5:30)
script eval charging.setSchedule(23, 30, 5, 30)

# Set charger power rating
script eval charging.setChargeRate(7.0)

# Set SOC targets
script eval charging.setLimits(80, 75)

# View current settings
script eval charging.getSchedule()
script eval charging.status()
```

**Advanced Method:** Edit the `config` object in `charging.js` for default values:

```javascript
var config = {
    // Cheap electricity rate window (24-hour format)
    cheapWindowStart: { hour: 23, minute: 30 },
    cheapWindowEnd: { hour: 5, minute: 30 },

    // Charging targets
    targetSOC: 80,          // Desired final SOC %
    skipIfAbove: 75,        // Skip charging if already above this %
    minSOCToCharge: 20,     // Safety: don't charge if below this

    // Charger specification (kW)
    chargeRateKW: 1.8,      // Adjust to your charger's rating

    // Ready-by time (null = use fixed schedule)
    readyBy: null,

    // Battery parameters (null = auto-detect from vehicle)
    batteryCapacityKWh: null,
    batterySOH: null
};
```

### Charger Power Ratings

Common charge rates:
- **1.8 kW** - Granny charger (standard wall outlet)
- **3.3 kW** - Type 2 slow (single-phase)
- **7.0 kW** - Type 2 fast (single-phase)
- **11 kW** - Type 2 fast (three-phase)
- **22+ kW** - Rapid chargers

## Usage

### Basic Commands

Connect to your OVMS module via SSH or web console, then use:

```javascript
// Information commands
charging.status()                   // Show complete status
charging.nextCharge()               // Quick view of next charge session
charging.getSchedule()              // Show current schedule times

// Manual controls
charging.start()                    // Start charging now
charging.stop()                     // Stop charging now

// Schedule configuration (NEW - user-friendly!)
charging.setSchedule(23, 30, 5, 30) // Set charging window (23:30 to 5:30)

// Other configuration
charging.setLimits(80, 75)          // Set target SOC to 80%, skip if above 75%
charging.setChargeRate(7.0)         // Set charger to 7kW (Type 2 fast)
charging.setReadyBy(7, 30)          // Ready by 7:30 AM (intelligent scheduling)
charging.clearReadyBy()             // Return to fixed schedule

// Automation (called by clock events)
charging.checkSchedule()            // Check time and start/stop as needed
```

### Examples

#### Example 1: Fixed Schedule (Default)

Charge every night during cheap rate hours:

```javascript
// Vehicle will charge from 23:30 to 05:30
// Set up via clock events (see Installation step 3)
```

#### Example 2: Intelligent "Ready By" Scheduling

Optimize charging to finish exactly when you need it:

```javascript
// Configure charger
charging.setChargeRate(7.0);        // 7kW Type 2 charger
charging.setLimits(80, 75);         // Target 80%, skip if above 75%

// Set ready-by time
charging.setReadyBy(7, 30);         // Ready by 7:30 AM

// The system will:
// 1. Check current SOC
// 2. Calculate kWh needed to reach 80%
// 3. Calculate charging time based on 7kW rate
// 4. Start charging at optimal time to finish at 7:30
// 5. Still respect cheap rate window (won't start before 23:30)
```

#### Example 3: Granny Charger (Slow Charging)

For overnight charging with a standard outlet:

```javascript
charging.setChargeRate(1.8);        // Granny charger
charging.setLimits(90, 85);         // Higher limits for slower charging
charging.setReadyBy(8, 0);          // Ready by 8:00 AM
```

#### Example 4: Rapid Charger

For quick top-ups:

```javascript
charging.setChargeRate(50);         // 50kW rapid charger
charging.setLimits(80, 70);         // Standard rapid charge limits
```

### Status Output

The `charging.status()` command shows:

```
=== OVMS Smart Charging Status ===
Time: 2025-10-25T22:00:00.000Z

Battery:
  Capacity: 40.0 kWh
  Health: 95%
  Usable: 38.0 kWh
  Charge rate: 7.0 kW

Schedule:
  Cheap rate: 23:30 to 05:30
  Mode: Ready By 07:30
  Optimal start: 02:45
  Charge time: 4.5 hours
  Target SOC: 80%
  Skip if above: 75%

Vehicle:
  SOC: 45%
  Charging: false
  State: stopped
  Plugged in: true
  Battery temp: 18 C

Ready to charge: true
```

## How It Works

### Battery Auto-Detection

The module automatically detects your battery specifications:

1. **Capacity**: Calculated from `v.b.cac` (Capacity Amp-Hours) × pack voltage
2. **State of Health**: Read from `v.b.soh` metric
3. **Fallback**: Uses sensible defaults (40 kWh, 100% SOH) if metrics unavailable
4. **Caching**: Battery parameters cached for 60 seconds to reduce overhead

### Intelligent Scheduling

When you set a "ready by" time:

1. Reads current SOC from vehicle
2. Calculates kWh needed: `(targetSOC - currentSOC) × usableCapacity`
3. Calculates charge time: `kWhNeeded ÷ chargerRateKW`
4. Works backwards from ready-by time to find optimal start
5. Constrains start time to cheap rate window
6. Updates calculation dynamically as SOC changes

### Safety Features

- **Pre-charge checks**: Won't start if not plugged in, already charging, or SOC sufficient
- **Minimum SOC protection**: Won't charge if SOC below `minSOCToCharge` (degraded battery protection)
- **Skip logic**: Automatically skips charging if SOC already above `skipIfAbove` threshold
- **Notifications**: All actions generate OVMS notifications for monitoring

### Event System

Clock events trigger automatic charging:
- `clock.HHMM` folders execute at specific times
- Multiple events possible (e.g., different schedules for weekdays/weekends)
- Event files processed in alphabetical order (use numeric prefixes)

## Troubleshooting

### Charging Doesn't Start

Check status with `charging.status()` and verify:

1. **Vehicle plugged in**: `Plugged in: true`
2. **Current SOC below skip threshold**: SOC < `skipIfAbove`
3. **Clock events created**: Check `/store/events/clock.HHMM/` directories
4. **Module loaded**: Should see "OVMS Smart Charging v1.0 loaded" on script reload

### Battery Values Incorrect

Override auto-detection:

```javascript
// Edit config in charging.js
config.batteryCapacityKWh = 62.0;  // Specify exact capacity
config.batterySOH = 92;             // Specify exact SOH
```

### Charge Time Calculation Wrong

Verify charger rate matches your hardware:

```javascript
charging.setChargeRate(7.0);  // Use your actual charger's kW rating
```

Check with multimeter or EVSE display if unsure.

### Script Not Loading

1. Check file location: `/store/scripts/lib/charging.js`
2. Check `ovmsmain.js` has: `charging = require("lib/charging");`
3. Reload JS engine: **Tools > Editor > Reload JS Engine**
4. Check for syntax errors in console output

### Commands Show No Output

If commands like `charging.status` show no output, you're missing the parentheses:

```javascript
// WRONG - No output (just references the function)
script eval charging.status

// CORRECT - Shows output (actually calls the function)
script eval charging.status()
```

**Remember:** All function calls need `()` to execute:
- `charging.status()` ✓
- `charging.start()` ✓
- `charging.nextCharge()` ✓

## Advanced Usage

### Multiple Charging Schedules

Create different clock events for different scenarios:

```bash
# Weekday schedule (earlier start)
/store/events/clock.2200/010-weekday-charge
  Content: script eval charging.start()

# Weekend schedule (later start)
/store/events/clock.0100/010-weekend-charge
  Content: script eval charging.start()

# Common stop time
/store/events/clock.0630/010-stop-charge
  Content: script eval charging.stop()
```

### Integration with Home Automation

Call OVMS API from your home automation system:

```bash
# Start charging via HTTP API
curl -u username:password "http://<ovms-ip>/api/execute?command=script+eval+charging.start()"

# Check status
curl -u username:password "http://<ovms-ip>/api/execute?command=script+eval+charging.status()"
```

### Monitoring with Notifications

All actions generate OVMS notifications that appear in the OVMS Connect mobile app:

- **Charge started**: "Charging started at 45%"
- **Charge stopped**: "Stopped at 80%"
- **Configuration changes**: "Target 80%, skip if above 75%"
- **Errors**: "Cannot start: not plugged in"

## Architecture

### Module Structure

```
charging.js
├── Configuration (config object)
├── Battery Detection (getBatteryParams)
├── Status & Information (status, nextCharge)
├── Charging Control (start, stop)
├── Configuration API (setLimits, setChargeRate, setReadyBy)
├── Internal Helpers (calculation functions)
└── Event Handlers (automatic stop)
```

### Key Functions

- `getBatteryParams()`: Auto-detect or return cached battery specs
- `calculateOptimalStart()`: Find best start time for ready-by target
- `canCharge()`: Safety checks before starting
- `scheduleStop()`: Set up automatic stop timer
- `getSafeMetric()`: Safely read vehicle metrics with fallbacks

## Contributing

Suggestions and improvements welcome! This module is designed to be universal and work with any OVMS-supported vehicle.

### Areas for Enhancement

- Multi-day scheduling (different rates on weekends)
- Solar integration (prefer solar hours)
- Dynamic rate pricing APIs
- Historical usage statistics
- Web UI for configuration

## License

Open source - use and modify as needed for your OVMS installation.

## Support

- **OVMS Documentation**: https://docs.openvehicles.com/
- **OVMS Forums**: https://www.openvehicles.com/forum
- **Vehicle Metrics**: Check your specific vehicle's metric names in OVMS

## Version History

- **v1.0** (2025-10-25): Initial release
  - Auto-detection of battery parameters
  - Intelligent "ready by" scheduling
  - Universal vehicle support
  - Full notification system
