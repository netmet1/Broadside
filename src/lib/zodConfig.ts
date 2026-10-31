// The Content-Security-Policy (tauri.conf.json) allows no eval. zod would try
// `Function()` once to see whether it can compile its checks, fall back, and
// leave a policy violation in the console; told up front, it never tries.
//
// A module of its own, imported first in main.tsx: imports run before the
// importing file's own code, so a call in main.tsx would come after every
// module that builds a schema at load time.
import { z } from "zod";

z.config({ jitless: true });
