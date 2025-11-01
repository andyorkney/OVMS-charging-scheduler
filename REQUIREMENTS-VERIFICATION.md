# OVMS Smart Charging - Requirements Verification Checklist

## Purpose
This document ensures all core features are implemented and tested before any code changes are merged.
Use this checklist to verify nothing is broken or missing.

---

## Critical Requirements (MUST WORK)

### 1. Stop Charging at Target SOC ⚠️ CRITICAL
**Requirement**: Charging must stop when SOC reaches `config.targetSOC` (e.g., 80%)
**Not**: Stop only at window end time (05:30)

**How to Verify**:
- [ ] Set target: `charging.setLimits(80, 75)`
- [ ] Start charging at low SOC (e.g., 60%)
- [ ] Monitor: Does it stop at 80%? Or continue to 95-100%?

**Expected Result**: Charging stops at 80% ± 2%

**Code Locations**:
- `start()` function: Must set OVMS charge limit
- `checkSchedule()`: Must monitor SOC and stop if >= target
- Line numbers: _____________

**Current Status**: ❌ was working we broke it - FAILING - Charges to 98% instead of 80-90%

---

### 2. Start Charging During Cheap Window
**Requirement**: Auto-start charging during configured cheap rate window

**How to Verify**:
- [ ] Set schedule: `charging.setSchedule(23,30,5,30)`
- [ ] Plug in vehicle at 22:00 with SOC < skipIfAbove
- [ ] Monitor: Does charging start at 23:30?

**Expected Result**: Charging starts within 30 minutes of window start (due to clock event interval)

**Code Locations**:
- `checkSchedule()`: Lines 658-667
- Clock events: Every 30 minutes

**Current Status**: ✅ WORKING - Confirmed in real world

---

### 3. Skip If SOC Already Sufficient
**Requirement**: Don't start charging if `current SOC >= config.skipIfAbove`

**How to Verify**:
- [ ] Set limits: `charging.setLimits(80, 75)`
- [ ] Plug in at 23:30 with SOC = 76%
- [ ] Monitor: Should skip charging

**Expected Result**: Log shows "Skip: SOC 76% >= 75% (already charged enough)"

**Code Locations**:
- `checkSchedule()`: Lines 660-667
- `canCharge()`: Lines 631-639

**Current Status**: ⚠️ UNVERIFIED - real world tests required

---

### 4. Auto-Detect Battery Parameters
**Requirement**: Automatically detect battery capacity and SOH from vehicle metrics

**How to Verify**:
- [ ] Run: `charging.status()`
- [ ] Check "Battery" section shows:
  - Capacity: Reasonable value (20-100 kWh typical)
  - Health: Reasonable SOH (70-100%)
  - Values match vehicle's actual specs

**Expected Result**: Correct capacity and SOH displayed

**Code Locations**:
- `getBatteryParams()`: Lines 129-183

**Current Status**: ⚠️ UNVERIFIED? - I think this is Verified working

---

### 5. Intelligent "Ready By" Scheduling
**Requirement**: Is at the required percentage ~~exactly at~~ BY ready-by (time) - unless there just is not enough time - warn if physically impossible to be ready on time. 

**How to Verify**:
- [ ] Set charger rate: `charging.setChargeRate(7.0)`
- [ ] Set ready-by: `charging.setReadyBy(7,30)`
- [ ] Run: `charging.status()`
- [ ] Check: Can charge percentage be reached after starting at 23:30 and ready by set-time
  - Example: If needs to be ready at 05:00, calculates time to start to be ready by 05:00 and warns of costs and timings.

**Expected Result**: Calculated start time needed to charge%, starts at that time with advisories

**Code Locations**:
- `calculateOptimalStart()`: Lines 677-776
- `checkSchedule()`: Lines 541-586

**Current Status**: ⚠️ UNVERIFIED

---

### 6. Notifications for All Actions
**Requirement**: Every charge start/stop sends OVMS notification

**How to Verify**:
- [ ] Manual start: `charging.start()`
- [ ] Check OVMS Connect app for notification
- [ ] Manual stop: `charging.stop()`
- [ ] Check for notification

**Expected Result**: Notifications appear in OVMS Connect app

**Code Locations**:
- All `safeNotify()` calls throughout code

**Current Status**: testing so far actually has 2x notification in OVMS COnnect 

---

### 7. Event-Driven (No Continuous CPU Load)
**Requirement**: Ideally No ticker events, only clock events every 30 minutes ?

**How to Verify**:
- [ ] Check no excessive `ticker.X` events subscribed
- [ ] Verify only `clock.HHMM` events exist
- [ ] Monitor: Event queue should not back up

**Expected Result**: Zero warnings about delayed ticker events

**Code Locations**:
- No ticker subscriptions in code
- Clock events: `/store/events/clock.HHMM/`

**Current Status**: ⚠️ Was broken (setup-events blocking), now fixed

---

### 8. ~~Stop at Window End Time (Fallback)~~ Warn that charge is not going to complete in window
**Requirement**: If SOC not reached, warn of time and cost outside window  (23:30 - 05:30)

**How to Verify**:
- [ ] Start charging at very low SOC (won't reach target in time)
- [ ] Monitor: Does it calculate time needed, start early, finish later and advice of costs?

**Expected Result**: Charging does best to charge in window but prioritises to reach percentage requested, warns and provides costs and end time.

**Code Locations**:
- `checkSchedule()`: Lines 672-675

**Current Status**: UNVERIFIED was WORKING (time-based stop exists and works but not as originally specified)

---

### 9. Pre-Charge Safety Checks
**Requirement**: Verify vehicle is plugged in, not already charging, SOC in valid range

**How to Verify**:
- [ ] Try to start when not plugged in: Should fail with message
- [ ] Try to start when already charging: Should skip
- [ ] Try to start when SOC >= skipIfAbove: Should skip

**Expected Result**: Appropriate error/skip messages

**Code Locations**:
- `canCharge()`: Lines 631-639
- `getChargeBlockReason()`: Lines 644-653

**Current Status**: ⚠️ UNVERIFIED

---

## Nice-to-Have Features (SHOULD WORK)

### 10. Cost Calculations with Overflow Warning
**Requirement**: Show estimated cost, warn if charging extends beyond cheap window and when estimated to finish

**How to Verify**:
- [ ] Run: `charging.status()` with ready-by mode
- [ ] Check: Shows overflow cost if charge duration > window duration

**Expected Result**: Warning shown when overflow detected

**Code Locations**:
- `calculateOptimalStart()`: Lines 744-770

**Current Status**: ✅ IMPLEMENTED (recently added to notifications)

---

### 11. Multiple Charge Rate Support
**Requirement**: Works with 1.8kW granny chargers up to 350kW rapid chargers

**How to Verify**:
- [ ] Set different rates: `charging.setChargeRate(1.8)`, `charging.setChargeRate(50)`
- [ ] Check time estimates adjust correctly

**Expected Result**: Charge time = kWh needed ÷ charge rate

**Code Locations**:
- `setChargeRate()`: Lines 409-423

**Current Status**: ⚠️ UNVERIFIED

---

## Verification Log

| Date | Tester | Requirement # | Result | Notes |
|------|--------|---------------|--------|-------|
| 2025-10-31 | User | 1 | ❌ FAIL | Charged to 98% instead of 80-90% |
| 2025-10-31 | User | 2 | ✅ PASS | Started at 23:30 as expected |
|  |  |  |  |  |

---

## Before Merging ANY Code Change

1. [ ] Review which requirements might be affected
2. [ ] Re-test those requirements
3. [ ] Update verification log
4. [ ] Confirm no regressions

---

## Critical Gaps Identified

### Gap #1: No SOC-Based Stopping ⚠️ CRITICAL
**Issue**: Original code only stops at window end time, not at target SOC
**Impact**: Vehicle overcharges to 98% instead of 80-90%
**Fix Status**: Implemented in commit df82a2b, needs deployment
**Fix Approach**:
- Set OVMS charge limit before starting
- Monitor SOC in checkSchedule() every 30 min
- Stop if SOC >= target

### Gap #2: Event Queue Blocking
**Issue**: setup-events.install() blocked event thread for 10 seconds
**Impact**: Ticker events delayed in queue
**Fix Status**: Fixed in commit 2e0aefd
**Fix Approach**: Limit file checks to 10 per run instead of all 48

---

## Test Scenarios

### Scenario 1: Normal Overnight Charge
1. SOC at 22:00: 65%
2. Target: 80%
3. Window: 23:30 - 05:30
4. Expected: Start 23:30, stop at 80% (~02:00 for 7kW charger)

### Scenario 2: Already Charged Enough
1. SOC at 23:30: 76%
2. Skip threshold: 75%
3. Expected: Skip charging, log message

### Scenario 3: Ready-By Mode
1. SOC at 22:00: 50%
2. Target: 80%
3. Ready by: 07:30
4. Charge rate: 7kW
5. Expected: Calculate start time, to ensue SOC is 80% +/-2%

---

## Regression Prevention

Before ANY commit:
1. Run through critical requirements 1-9
2. Document which ones you tested
3. Document any that broke
4. Fix before merging

This prevents the "declare success without verification" problem.
