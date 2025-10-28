# OVMS Event Files Setup Guide

This guide explains how to set up clock event files on your OVMS module to enable automatic charging.

## ⭐ RECOMMENDED METHOD: Automated Schedule Check

**The easiest way** is to create clock events that run `charging.checkSchedule()` periodically, then configure your times via simple commands.

### Quick Setup

1. **Create one clock event file** that runs every 30 minutes:

```bash
ssh root@<your-ovms-ip>

# Create the event file content
EVENT_CONTENT="script eval charging.checkSchedule()"

# Create clock events for every 30 minutes (48 events total)
for hour in {0..23}; do
    for minute in 00 30; do
        DIR="/store/events/clock.$(printf '%02d%02d' $hour $minute)"
        mkdir -p "$DIR"
        echo "$EVENT_CONTENT" > "$DIR/charging-check"
    done
done

echo "Clock events created!"
```

2. **Set your charging times via command** (no file editing needed!):

```bash
# SSH into OVMS or use the web console
script eval charging.setSchedule(23, 30, 5, 30)
```

That's it! The system will automatically:
- Check every 30 minutes if it's time to charge
- Start charging at 23:30 if plugged in and SOC below threshold
- Stop charging at 5:30

3. **Change times anytime** without editing files:

```bash
script eval charging.setSchedule(22, 0, 6, 0)   # Change to 22:00-06:00
script eval charging.getSchedule()               # View current schedule
```

### Benefits

✅ **No file editing** - Just run commands to change times
✅ **One-time setup** - Create events once, change times anytime
✅ **Flexible** - Works with overnight schedules (23:30-05:30)
✅ **Safe** - Won't start if already charged or unplugged

---

## Alternative: Manual Event Method

If you prefer more control, you can create specific start/stop events manually.

## Event System Overview

OVMS uses an event-driven system where specific actions can be triggered at specific times using "clock events". Clock events are organized in directories named `clock.HHMM` where `HHMM` is the 24-hour time.

## Directory Structure

On your OVMS module, event files should be created in:

```
/store/events/clock.HHMM/filename
```

For example:
```
/store/events/clock.2330/010-start-charge
/store/events/clock.0530/010-stop-charge
```

## Creating Event Files

### Method 1: Via OVMS Web Interface

1. Connect to your OVMS module's web interface
2. Go to **Tools > Editor**
3. Navigate to `/store/events/`
4. Create directories and files as shown below

### Method 2: Via SSH

Connect to your OVMS module via SSH and create the files:

```bash
# Connect to OVMS
ssh root@<your-ovms-ip>

# Create event directories
mkdir -p /store/events/clock.2330
mkdir -p /store/events/clock.0530

# Create start event (23:30 = 11:30 PM)
cat > /store/events/clock.2330/010-start-charge << 'EOF'
script eval charging.start()
EOF

# Create stop event (05:30 = 5:30 AM)
cat > /store/events/clock.0530/010-stop-charge << 'EOF'
script eval charging.stop()
EOF

# Make files executable (optional but recommended)
chmod +x /store/events/clock.2330/010-start-charge
chmod +x /store/events/clock.0530/010-stop-charge
```

## Event File Examples

### Basic Daily Charging

**Start at 11:30 PM (23:30)**

File: `/store/events/clock.2330/010-start-charge`
```
script eval charging.start()
```

**Stop at 5:30 AM (05:30)**

File: `/store/events/clock.0530/010-stop-charge`
```
script eval charging.stop()
```

### Multiple Daily Windows

You can have multiple charging windows by creating multiple clock events:

**Morning top-up at 10:00 AM**

File: `/store/events/clock.1000/010-morning-charge`
```
script eval charging.start()
```

**Stop morning charge at 11:00 AM**

File: `/store/events/clock.1100/010-stop-morning-charge`
```
script eval charging.stop()
```

### Intelligent Ready-By Scheduling

For dynamic start times based on "ready by" target:

**Configure at midnight**

File: `/store/events/clock.0000/010-configure-charging`
```
script eval charging.setReadyBy(7, 30)
```

**Start at calculated optimal time (still use fixed event as backup)**

File: `/store/events/clock.2330/010-start-charge`
```
script eval charging.start()
```

The module will calculate the optimal start time and only start if needed.

### Status Notifications

**Daily status check at 6:00 PM**

File: `/store/events/clock.1800/010-status-check`
```
script eval charging.nextCharge()
```

This will send a notification showing when the next charge will occur.

### Configuration Updates

**Update limits on specific days**

File: `/store/events/clock.0700/010-set-weekday-limits`
```
script eval charging.setLimits(80, 75)
```

## File Naming Convention

Event files are executed in alphabetical order. Use numeric prefixes to control execution order:

```
010-first-action
020-second-action
030-third-action
```

This is useful when you need multiple actions at the same time:

```
/store/events/clock.2330/
  010-configure-charger
  020-start-charge
```

## Time Format Reference

Clock events use 24-hour format (HHMM):

| Time     | Directory Name |
|----------|----------------|
| 12:00 AM | clock.0000     |
| 1:00 AM  | clock.0100     |
| 6:30 AM  | clock.0630     |
| 12:00 PM | clock.1200     |
| 5:30 PM  | clock.1730     |
| 11:30 PM | clock.2330     |

## Testing Events

### Manual Event Trigger

To test an event without waiting for the scheduled time:

```bash
# Via SSH
script eval charging.start()

# Or trigger the event file directly
/store/events/clock.2330/010-start-charge
```

### Check Event Execution

Monitor OVMS logs to see event execution:

```bash
# Via SSH
tail -f /var/log/ovms.log
```

### Verify Clock Events

List all configured clock events:

```bash
# Via SSH
ls -la /store/events/clock.*/
```

## Common Configurations

### Configuration 1: Simple Overnight Charging

Charge during cheap night rate (23:30 to 05:30):

```bash
# /store/events/clock.2330/010-start-charge
script eval charging.start()

# /store/events/clock.0530/010-stop-charge
script eval charging.stop()
```

### Configuration 2: Granny Charger (Slow)

Longer charging window for slow charger:

```bash
# /store/events/clock.2000/010-configure-slow
script eval charging.setChargeRate(1.8)

# /store/events/clock.2000/020-start-charge
script eval charging.start()

# /store/events/clock.0800/010-stop-charge
script eval charging.stop()
```

### Configuration 3: Ready-By Intelligent Mode

Optimize start time for 7:30 AM departure:

```bash
# /store/events/clock.2200/010-configure-ready-by
script eval charging.setReadyBy(7, 30)

# /store/events/clock.2330/010-start-if-needed
script eval charging.start()
```

The module calculates when to actually start based on current SOC.

### Configuration 4: Multiple Rate Periods

Different charging strategies for different rate periods:

```bash
# Super cheap rate (01:00-05:00)
# /store/events/clock.0100/010-cheap-rate-start
script eval charging.setLimits(90, 85)
script eval charging.start()

# Normal cheap rate (23:30-01:00)
# /store/events/clock.2330/010-normal-rate-start
script eval charging.setLimits(80, 75)
script eval charging.start()

# Stop at rate change
# /store/events/clock.0500/010-stop-charge
script eval charging.stop()
```

## Troubleshooting

### Events Not Executing

1. **Check file permissions**: Files should be readable
   ```bash
   chmod 644 /store/events/clock.*/010-*
   ```

2. **Verify directory structure**: Must be exactly `clock.HHMM`
   ```bash
   ls -la /store/events/
   ```

3. **Check script syntax**: Test commands manually first
   ```bash
   script eval charging.status()
   ```

4. **Review logs**: Check for error messages
   ```bash
   tail -f /var/log/ovms.log
   ```

### Clock Drift

If events execute at wrong times:

1. Check OVMS system time:
   ```bash
   date
   ```

2. Ensure timezone is set correctly in OVMS config

3. Enable NTP time synchronization if available

### Events Execute But Charging Doesn't Start

Check charging status to diagnose:

```bash
script eval charging.status()
```

Look for:
- Vehicle plugged in: `Plugged in: true`
- SOC below skip threshold
- No existing charge in progress

## Advanced: Conditional Events

You can add logic to event files:

```bash
# /store/events/clock.2330/010-conditional-charge
script eval if (OvmsMetrics.AsFloat("v.b.soc") < 75) { charging.start(); }
```

This only starts charging if SOC is below 75%.

## Summary Checklist

- [ ] Created `/store/events/clock.HHMM/` directories for each event time
- [ ] Created event files with correct content
- [ ] Used numeric prefixes (010-, 020-) for proper ordering
- [ ] Tested events manually before relying on scheduled execution
- [ ] Verified OVMS system time is correct
- [ ] Checked logs to confirm events execute
- [ ] Confirmed charging module is loaded (`charging.status()` works)

## Additional Resources

- OVMS Event System: https://docs.openvehicles.com/en/latest/userguide/events.html
- OVMS Scripting: https://docs.openvehicles.com/en/latest/userguide/scripting.html
- Clock Events Reference: https://docs.openvehicles.com/en/latest/userguide/events.html#clock-events
