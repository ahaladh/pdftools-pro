import { z } from 'zod';
// zod 4 probes whether `new Function` works to compile faster parsers. Our CSP forbids eval (rightly), and the probe itself is
// reported as a violation, so turn the fast path off: parsing is slightly slower and CSP stays clean.
z.config({ jitless: true });
