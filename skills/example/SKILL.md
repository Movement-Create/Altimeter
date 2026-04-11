---
name: example-skill
description: Example skill demonstrating SKILL.md format
tools_required: [bash, file_read]
trigger_patterns: [example, demo, template]
always_inject: false
---

# Example Skill

This is an example skill. When a user mentions "example", "demo", or "template",
this skill gets injected into the agent's system prompt.

## Guidelines

When working on example/demo code:
1. Write clear, well-commented code
2. Include a README with usage instructions
3. Add error handling
4. Write at least basic tests

## Common Patterns

```typescript
// Pattern: async function with error handling
async function doSomething(input: string): Promise<Result> {
  try {
    const result = await process(input);
    return { success: true, data: result };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}
```
