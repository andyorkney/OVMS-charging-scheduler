# Smart Charging System - Change Log

**Purpose:** Track all changes to design and implementation
**Rule:** No code changes without documenting here first

---

## Version 1.1 - 2025-01-15 (CLIMATE WAKE RETRY)

**Status:** Design updated - ready for implementation

### What Changed:

**Major Feature: Automatic Charge Interruption Recovery**
- Added intelligent retry mechanism for charge interruptions
- Implements climate wake cycle to restore pilot signal
- Uses callback-based approach (safe for DukTape engine)
- Maximum 3 retry attempts with exponential backoff (2, 5, 10 minutes)
- Timestamps added to all notifications

**Climate Wake Cycle:**
- Command: `climatecontrol on` → wait 10s → `climatecontrol off` → wait 5s
- Purpose: Restore pilot signal after OVMS reboot or connection loss
- Executes before each retry attempt

**Retry Logic:**
- Attempt 1: Wait 2 minutes → Climate wake → Retry
- Attempt 2: Wait 5 minutes → Climate wake → Retry
- Attempt 3: Wait 10 minutes → Climate wake → Retry
- After 3 failures: Notify user and stop trying

**Notification Changes:**
- All notifications now include timestamp: `[HH:MM] message`
- New interrupt notifications show attempt count: `(attempt 1/3)`
- Failure notification includes clear action: "Please check vehicle and charger"

### Why:

**User Requirement:** "If I have journey to make I'd prefer to get there than wake up to car without energy"
- Power cuts, pilot signal loss, loose connections can interrupt charging
- Without retry, user wakes up with insufficient charge
- Violates Priority #1: Reach target SOC

**ENV200-Specific Issue:**
- After OVMS reboot, pilot signal can fail
- Climate control cycle reliably restores pilot
- Must use this workaround for reliable charging

### Who Agreed:

- User (andyorkney) - 2025-01-15
- Specified: Option A (always climate wake) + Option 2 (simple notifications) + timestamps

### Impact:

**Code Changes Required:**
- Add `getTimestamp()` helper function
- Add `performClimateWake(callback)` function
- Add `handleChargeInterruption(current_soc, target_soc)` function
- Modify `monitorSOC()` to call interruption handler
- Add `state.retry_count` tracking
- Update all `notify()` calls to include timestamps

**Testing Required:**
- ✅ Test climate wake commands work (`climatecontrol on/off`)
- ✅ Test retry logic with simulated interruptions
- ✅ Verify timestamps display correctly in notifications
- ✅ Confirm no async/await used (DukTape compatibility)
- ✅ Test timer cleanup (no memory leaks)
- ✅ Verify 3-attempt limit works
- ✅ Test manual override does NOT retry

**User-Visible Changes:**
- Notifications now show time of event
- Charge interruptions auto-recover (up to 3 attempts)
- Climate briefly activates during retry (user may notice cabin fan)
- More notifications during retry sequence

**Design Document Changes:**
- Updated SMART-CHARGING-DESIGN.md to v1.1
- Added Scenario 6 (charge interruption recovery)
- Added "On Charge Interruption" decision logic
- Updated notification formats with timestamps
- Added climate wake commands to technical notes
- Added DukTape compatibility warning

### Rollback Plan:

If retry logic causes issues:
1. Revert to v1.0 design spec
2. Remove retry functions from code
3. Keep timestamp feature (harmless improvement)
4. Fall back to simple "interrupted" notification only

---

## Version 1.0 - 2025-01-15 (BASELINE)

**Status:** Initial design specification - LOCKED

### Design Decisions Made:

✅ SOH-aware battery capacity calculations
✅ Hybrid charger rate detection (config + live)
✅ Fixed ready-by time (user configurable, default 07:30)
✅ Alert if scheduled start missed (not plugged in)
✅ Prefer cheap window start, accept overspill to reach target
✅ Always charge to exact target SOC (no skipIfAbove threshold)
✅ Manual override via app button
✅ Electricity rates: £0.07 cheap, £0.292 standard (Intelligent Octopus Go)
✅ Granny charger default: 1.8 kW

### Features Deferred:

⏸️ Low battery reminder alerts (at home, not plugged in)
⏸️ Cost minimization mode (retired couple scenario)
⏸️ Dynamic window adjustment
⏸️ Historical tracking

### Implementation:

**File:** `/store/scripts/lib/charging.js`
**Version:** v3.0.0
**Lines:** ~550
**Based on:** v2.0.7.3 structure

### Testing Required:

- ✅ Plug-in event detection (which event fires on ENV200?)
- ✅ Charge start/stop commands work
- ✅ SOC monitoring accuracy
- ✅ Cost calculations verified
- ✅ Notifications display correctly

---

## Change Template (For Future Updates)

### Version X.X - YYYY-MM-DD

**What Changed:**
- Description of change

**Why:**
- Reason for change

**Who Agreed:**
- Name/Date

**Impact:**
- Code changes required
- Testing required
- User-visible changes

**Rollback Plan:**
- How to revert if needed

---

## Pending Changes (Under Discussion)

None currently

---

## Known Issues

### Issue #1: Event Detection Unknown (Testing Required)

**Problem:** Don't yet know which event fires on ENV200 plug-in
**Options:** `vehicle.charge.prepare` OR `vehicle.charge.start`
**Status:** Needs testing with real vehicle
**Impact:** May need to adjust event subscription in code
**Workaround:** Currently subscribe to both events

### Issue #2: Climate Wake Timing Unknown (Testing Required)

**Problem:** Don't know optimal timing for climate on/off cycle
**Current:** 10 seconds on, 5 seconds off
**Status:** Needs testing with real vehicle
**Impact:** May need to adjust timing if pilot doesn't restore
**Workaround:** User can report if timing needs adjustment

---

**End of Change Log**
