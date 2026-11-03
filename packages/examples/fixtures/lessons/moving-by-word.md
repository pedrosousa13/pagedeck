---
order: 1
---
# Moving by word

Each step is a fenced block the lesson's schema reads out of the entry's
`body`.

```json
{ "keys": "w", "expect": "the cursor is on the next word" }
```

Then go back.

```json
{ "keys": "b", "expect": "the cursor is back on the first word" }
```
