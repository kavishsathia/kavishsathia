// Copyright 2026 Kavish Sathia. Apache-2.0.
package site.pluscal;

import java.io.PrintWriter;
import java.io.StringWriter;

/** Just enough JSON for the facade's replies. */
final class Json {
  private Json() {}

  static String escape(String s) {
    StringBuilder b = new StringBuilder(s.length() + 16);
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '"': b.append("\\\""); break;
        case '\\': b.append("\\\\"); break;
        case '\n': b.append("\\n"); break;
        case '\r': b.append("\\r"); break;
        case '\t': b.append("\\t"); break;
        default:
          if (c < 0x20) {
            b.append(String.format("\\u%04x", (int) c));
          } else {
            b.append(c);
          }
      }
    }
    return b.toString();
  }

  static String str(String s) {
    return s == null ? "null" : "\"" + escape(s) + "\"";
  }

  static String failure(Throwable t) {
    StringWriter sw = new StringWriter();
    t.printStackTrace(new PrintWriter(sw));
    return "{\"ok\":false,\"error\":" + str(t.toString()) + ",\"stack\":" + str(sw.toString()) + "}";
  }
}
