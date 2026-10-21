---
section: reference
title: React Compiler
description: Which modules React Compiler memoizes in pagedeck build and pagedeck dev, what its warnings mean, and how "use no memo" opts out.
---

# React Compiler

Pagedeck compiles every island with React Compiler. The compiler it runs is
`oxc-transform-react`, React Compiler's Rust port. You write nothing to turn it
on.

The compiler memoizes your components for you. A compiled component keeps the
values and elements it computed on one render. On the next render, it reuses
each one whose inputs did not change. That is the work `useMemo`, `useCallback`
and `memo` do when you write them by hand.

## What is compiled

The compiler reads every module the browser loads for an island. That is the
island's own module and every module it imports. Modules under `node_modules`
are compiled too, because a design system's islands live there. React's own
packages, `react`, `react-dom` and `scheduler`, are left alone.

`pagedeck build` and `pagedeck dev` both compile, so an island behaves the same
in each. Neither compiles server rendering. The HTML of a page comes from your
components as you wrote them, and the compiler changes only the JavaScript the
browser runs. A component that no island imports ships no JavaScript, so the
compiler never sees it.

## A skipped component

The compiler relies on React's rules for components and hooks. When a component
breaks one, the compiler skips it. The component renders as you wrote it, with
no automatic memoization, and the build warns.

This island gives each field an id from a counter outside the component.
`components/email-field.tsx`:

```tsx
"use client";

let nextId = 0;

export default function EmailField() {
  nextId += 1;
  const id = `email-${nextId}`;
  return (
    <p>
      <label htmlFor={id}>Email</label> <input id={id} type="email" />
    </p>
  );
}
```

`pagedeck build` prints:

```
pagedeck: Module "/home/you/my-site/components/email-field.tsx" line 6: React Compiler skipped component "EmailField" — Cannot reassign variables declared outside of the component/hook: Variable `nextId` is declared outside of the component/hook. Reassigning this value during render is a side effect which can cause unpredictable behavior. If this variable is used in rendering, use useState instead. Otherwise, update it in an effect. It renders as written, without automatic memoization.
```

The warning names the module, the line, the component, the rule and the fix.
The rule and the fix are the compiler's own words. A component that breaks a
rule in three places gets three warnings, one for each place. The build still
passes.

Here the counter only gives each field a unique id, and React's `useId` does
that. `components/email-field.tsx`:

```tsx
"use client";

import { useId } from "react";

export default function EmailField() {
  const id = useId();
  return (
    <p>
      <label htmlFor={id}>Email</label> <input id={id} type="email" />
    </p>
  );
}
```

The compiler compiles this version, and the build prints no warning.

`pagedeck dev` prints the same warning when the browser first loads the module.
After each edit, it prints the module's warnings again, once. An edit that fixes
the rule prints nothing.

Only your own modules warn. A component under `node_modules` that breaks a rule
is skipped the same way, without a warning, because you cannot edit it.

## Opting out

Write `"use no memo"` at the top of a function, before any other statement. The
compiler leaves that function as written and prints no warning for it.
`"use no forget"` does the same. `components/email-field.tsx`:

```tsx
"use client";

let nextId = 0;

export default function EmailField() {
  "use no memo";
  nextId += 1;
  const id = `email-${nextId}`;
  return (
    <p>
      <label htmlFor={id}>Email</label> <input id={id} type="email" />
    </p>
  );
}
```

The build prints nothing for this module. Write the directive at the top of the
module, beside `"use client"`, and it opts out every function in the module.
`components/email-field.tsx`:

```tsx
"use client";
"use no memo";

let nextId = 0;

export default function EmailField() {
  nextId += 1;
  const id = `email-${nextId}`;
  return (
    <p>
      <label htmlFor={id}>Email</label> <input id={id} type="email" />
    </p>
  );
}
```

Use it for a component that breaks a rule on purpose, or one you will fix later.
It does not silence a [crash](#a-crash).

## A crash

The compiler runs in a separate process. When that process dies on a module, the
module ships as written and the build warns:

```
pagedeck: Module "/home/you/my-site/components/chart.tsx": React Compiler crashed — its process exited on SIGSEGV while compiling the module. That is a fault in the compiler rather than a rule a component broke, so report it as a React Compiler bug; "use no memo" does not silence it, because the crash happens whether or not the directive is present. The module renders as written, without automatic memoization.
```

The build stops the compiler on a module that takes longer than 5 seconds. That
module gets the same warning, with `ran past 5 s` in place of
`exited on SIGSEGV`.

A crash is a fault in the compiler, not in your component. Report it against
`oxc-transform-react`, and name the module. The build carries on, and the next
module goes to a new process. A crash in a module under `node_modules` warns
too, because a report needs the module's name.

## A module the compiler cannot read

In `pagedeck dev`, a module with a syntax error reaches the compiler, and the
compiler stops on it. `components/label.ts`:

```ts
export function label( {
  return "Email";
}
```

The terminal prints:

```
pagedeck: Module "/home/you/my-site/components/label.ts": React Compiler stopped on 1 fatal diagnostic and produced no code — correct each line below, then build again:
pagedeck:   line 2: Expected `:` but found `string`
```

The browser shows the same error in Vite's overlay. The server keeps running.
Save a fix, and the module compiles again.

`pagedeck build` parses every island module before it compiles one. A syntax
error stops the build there with exit code 2, and the message quotes the lines
around the error. A module that parses but that the compiler still cannot read
fails the build with the compiler's message above, also with exit code 2.
