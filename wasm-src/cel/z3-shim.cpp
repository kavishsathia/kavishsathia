// Tiny shim linked into the Z3 wasm build: an error handler that does
// nothing, so API errors are reported through Z3_get_error_code (which is
// exactly what the Java binding's generated wrappers check after every call)
// instead of Z3's default handler, which aborts the process.
#include "z3.h"

static void noop_error_handler(Z3_context c, Z3_error_code e) {
  (void)c;
  (void)e;
}

extern "C" void cel_set_noop_error_handler(Z3_context c) {
  Z3_set_error_handler(c, noop_error_handler);
}
