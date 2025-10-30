# OVMS + Duktape Development Guidelines

## Critical Rules

### JavaScript Compatibility (Duktape ES5.1)
- Use `var` only (no `let`/`const`)
- No arrow functions (`=>`)
- No template literals (`` `${var}` ``)
- No modern array methods (`.includes()`, `.find()`, etc.)
- No spread operator (`...`)
- No destructuring
- No `class` keyword (use function constructors)
- No `async`/`await` or Promises

### OVMS CLI Command Syntax
**ALWAYS quote script eval commands:**
```
script eval "charging.checkSchedule()"
script eval "charging.setSchedule(23, 30, 5, 30)"
```

**Why:** OVMS CLI parser treats spaces as argument separators. Without quotes, commands with spaces will fail.

---

## IN-CODE DOCUMENTATION RULES (CRITICAL!)

### All function usage examples in comments MUST include the full OVMS command:

**WRONG:**
```javascript
/**
 * Check current schedule status
 * Usage: charging.checkSchedule()
 */
```

**CORRECT:**
```javascript
/**
 * Check current schedule status
 * Usage: script eval "charging.checkSchedule()"
 */
```

**WRONG:**
```javascript
// Set schedule: setSchedule(startHour, startMin, endHour, endMin)
```

**CORRECT:**
```javascript
// Set schedule: script eval "charging.setSchedule(startHour, startMin, endHour, endMin)"
```

### Why this matters:
Users copy/paste examples from code comments directly into OVMS CLI. If examples don't include `script eval "..."`, they won't work.

### Every function comment must show:
1. The full command: `script eval`
2. Quoted syntax: `"function()"`
3. Realistic example values

**Template for all function documentation:**
```javascript
/**
 * Function description
 *
 * @param paramName - description
 * @returns description
 *
 * Usage: script eval "moduleName.functionName(arg1, arg2)"
 * Example: script eval "charging.setSchedule(23, 30, 5, 30)"
 */
```

---

## README Documentation Rules

All command examples in README.md must:
- Include `script eval` prefix
- Use quoted syntax
- Show realistic parameter values
- Be formatted consistently

**Example section format:**
```markdown
### Check Schedule Status
```
script eval "charging.checkSchedule()"
```

Returns current schedule and charging status.
```

---

## Testing Before Commit

Test locally with Duktape:
```bash
cd /path/to/project
duk script-name.js
```

All code must pass Duktape validation without syntax errors.

**Common Duktape errors to watch for:**
- `SyntaxError: invalid object literal` → arrow functions or template literals
- `ReferenceError: identifier 'let' undefined` → using let/const
- `TypeError: undefined not callable` → modern methods that don't exist in ES5

---

## For AI Assistants / Claude Code

**READ THIS FILE FIRST** before making any changes to:
- JavaScript source files
- README.md
- Code comments

**On every change, verify:**
1. ✅ All JavaScript is ES5 compliant
2. ✅ All function comments include `script eval "..."` syntax
3. ✅ All README examples use quoted syntax
4. ✅ No modern JavaScript features introduced

**When in doubt:** Test with `duk` command locally.
