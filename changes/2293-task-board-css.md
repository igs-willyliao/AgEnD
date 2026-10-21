---
section: Fixed
---
- **The task board has its styles on a desk again (#2293).** The global search's phone-only block in the stylesheet was left open, so everything after it, the task board's styles among them, applied on phones only: on a desk the board showed as unstyled text and buttons. The block is closed, and a test now checks that every stylesheet the app ships closes its blocks.
