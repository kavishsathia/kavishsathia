// Copyright 2026 Kavish Sathia. Apache-2.0.
//
// Desktop-JVM check of CelVerifierWeb.evaluate (no Z3 involved), run by
// build.sh against the freshly compiled classes.
package dev.cel.verifier.tools;

public final class EvalCheck {
  private static int failures = 0;

  private static void expect(String label, String actual, String... needles) {
    for (String n : needles) {
      if (!actual.contains(n)) {
        failures++;
        System.out.println("FAIL " + label + ": missing " + n + "\n  got " + actual);
        return;
      }
    }
    System.out.println("ok   " + label);
  }

  private static String b(String... kv) {
    StringBuilder sb = new StringBuilder();
    for (int i = 0; i < kv.length; i += 2) {
      if (sb.length() > 0) sb.append('\u001e');
      sb.append(kv[i]).append('\u001f').append(kv[i + 1]);
    }
    return sb.toString();
  }

  private static String e(String... exprs) {
    return String.join("\u001e", exprs);
  }

  public static void main(String[] args) {
    String vars = "tool:string\nresource:string\namount:int";
    String event = b("tool", "'write_file'", "resource", "'/etc/passwd'", "amount", "3");

    expect("classifies with real CEL semantics",
        CelVerifierWeb.evaluate(vars, event, e(
            "tool == 'write_file' && resource.startsWith('/etc/')",
            "tool == 'read_file'",
            "amount > 2 && amount / (amount - 3) > 0")),
        "\"inputErrors\":[]", "{\"ok\":true,\"value\":true}", "{\"ok\":true,\"value\":false}",
        "\"kind\":\"eval\"", "/ by zero");
    expect("non-bool expression is a type error",
        CelVerifierWeb.evaluate(vars, event, e("amount + 1")), "\"kind\":\"type\"", "not bool");
    expect("undeclared identifier is a compile error",
        CelVerifierWeb.evaluate(vars, event, e("user == 'x'")), "\"kind\":\"compile\"", "user");
    expect("missing field",
        CelVerifierWeb.evaluate(vars, b("tool", "'x'", "resource", "'y'"), e("true")),
        "{\"field\":\"amount\",\"error\":\"missing value\"}", "\"results\":[]");
    expect("type mismatch: string for int",
        CelVerifierWeb.evaluate(vars, b("tool", "'x'", "resource", "'y'", "amount", "'3'"), e("true")),
        "\"field\":\"amount\"", "expected type 'int' but found 'string'");
    expect("no implicit int->double",
        CelVerifierWeb.evaluate("x:double", b("x", "5"), e("x > 1.0")), "\"field\":\"x\"", "expected type 'double' but found 'int'");
    expect("unknown field rejected",
        CelVerifierWeb.evaluate(vars, event + "\u001e" + "extra\u001f1", e("true")),
        "{\"field\":\"extra\",\"error\":\"not a declared field\"}");
    expect("literal may not reference fields",
        CelVerifierWeb.evaluate(vars, b("tool", "resource", "resource", "'y'", "amount", "1"), e("true")),
        "\"field\":\"tool\"");
    expect("lists and extensions",
        CelVerifierWeb.evaluate("tags:list<string>", b("tags", "['a', 'B']"),
            e("tags.exists(t, t.lowerAscii() == 'b')", "sets.contains(tags, ['a'])", "[] == tags")),
        "\"results\":[{\"ok\":true,\"value\":true},{\"ok\":true,\"value\":true},{\"ok\":true,\"value\":false}]");
    expect("empty list literal fits list<string>",
        CelVerifierWeb.evaluate("tags:list<string>", b("tags", "[]"), e("tags.size() == 0")),
        "{\"ok\":true,\"value\":true}");

    if (failures > 0) {
      System.out.println(failures + " failure(s)");
      System.exit(1);
    }
    System.out.println("EvalCheck: all passed");
  }
}
