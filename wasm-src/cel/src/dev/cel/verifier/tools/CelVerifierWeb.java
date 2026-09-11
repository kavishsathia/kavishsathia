// Copyright 2026 Kavish Sathia. Apache-2.0.
//
// Browser entry point for the CEL verifier. Lives in the tools package so it
// can reuse CelVerifierToolCore and VerificationOptions exactly as the REPL
// does; the only thing it adds is a JSON envelope for JavaScript.
package dev.cel.verifier.tools;

import com.google.common.collect.ImmutableMap;
import dev.cel.common.CelAbstractSyntaxTree;
import dev.cel.common.CelValidationException;
import dev.cel.common.types.CelType;
import dev.cel.compiler.CelCompiler;
import dev.cel.verifier.CelVerificationResult;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

public final class CelVerifierWeb {
  private CelVerifierWeb() {}

  /** Variables arrive one per line as {@code name:type}; unknowns one per line. */
  private static ImmutableMap<String, CelType> vars(String varSpecs) {
    List<String> specs = new ArrayList<>();
    for (String line : varSpecs.split("\n")) {
      String s = line.trim();
      if (!s.isEmpty() && !s.startsWith("//") && !s.startsWith("#")) {
        specs.add(s);
      }
    }
    return VerificationOptions.parseVariables(specs);
  }

  private static VerificationOptions options(int timeoutMs, int unroll, String unknowns) {
    List<String> ids = new ArrayList<>();
    for (String line : unknowns.split("\n")) {
      String s = line.trim();
      if (!s.isEmpty()) {
        ids.add(s);
      }
    }
    return VerificationOptions.builder()
        .setTimeout(Duration.ofMillis(timeoutMs))
        .setComprehensionUnrollLimit(unroll)
        .setUnknownIdentifiers(ids)
        .build();
  }

  private static String ok(CelVerificationResult r) {
    return "{\"ok\":true,\"status\":\""
        + r.status()
        + "\",\"reason\":\""
        + FormatUtils.escapeJson(r.reason())
        + "\",\"counterexample\":\""
        + FormatUtils.escapeJson(r.counterexample())
        + "\",\"message\":\""
        + FormatUtils.escapeJson(r.message())
        + "\"}";
  }

  private static String fail(Throwable t) {
    Throwable root = t;
    while (root.getCause() != null && root.getCause() != root) {
      root = root.getCause();
    }
    String kind = t instanceof CelValidationException ? "compile" : "runtime";
    StringWriter sw = new StringWriter();
    t.printStackTrace(new PrintWriter(sw));
    return "{\"ok\":false,\"kind\":\""
        + kind
        + "\",\"error\":\""
        + FormatUtils.escapeJson(t.getMessage() == null ? t.toString() : t.getMessage())
        + "\",\"rootError\":\""
        + FormatUtils.escapeJson(root.toString())
        + "\",\"stack\":\""
        + FormatUtils.escapeJson(sw.toString())
        + "\"}";
  }

  /** Parse + type-check only. Exercises cel-java without touching Z3. */
  public static String compile(String expression, String varSpecs) {
    try {
      CelCompiler compiler = CelVerifierToolCore.buildCompiler(vars(varSpecs));
      CelAbstractSyntaxTree ast = compiler.compile(expression).getAst();
      return "{\"ok\":true,\"type\":\""
          + FormatUtils.escapeJson(ast.getResultType().toString())
          + "\",\"expr\":\""
          + FormatUtils.escapeJson(ast.getExpr().toString())
          + "\"}";
    } catch (Throwable t) {
      return fail(t);
    }
  }

  public static String sat(
      String expression, String varSpecs, int timeoutMs, int unroll, String unknowns) {
    try {
      return ok(
          CelVerifierToolCore.checkSatisfiable(
              expression, vars(varSpecs), options(timeoutMs, unroll, unknowns)));
    } catch (Throwable t) {
      return fail(t);
    }
  }

  public static String valid(
      String expression, String varSpecs, int timeoutMs, int unroll, String unknowns) {
    try {
      return ok(
          CelVerifierToolCore.checkValid(
              expression, vars(varSpecs), options(timeoutMs, unroll, unknowns)));
    } catch (Throwable t) {
      return fail(t);
    }
  }

  public static String equiv(
      String exprA, String exprB, String varSpecs, int timeoutMs, int unroll, String unknowns) {
    try {
      return ok(
          CelVerifierToolCore.verifyEquivalence(
              exprA, exprB, vars(varSpecs), options(timeoutMs, unroll, unknowns)));
    } catch (Throwable t) {
      return fail(t);
    }
  }

  public static String policyInvariants(
      String yaml, String varSpecs, int timeoutMs, int unroll, String unknowns) {
    try {
      ImmutableMap<String, CelVerificationResult> results =
          CelVerifierToolCore.verifyPolicyInvariants(
              yaml, vars(varSpecs), options(timeoutMs, unroll, unknowns));
      StringBuilder sb = new StringBuilder("{\"ok\":true,\"invariants\":[");
      boolean first = true;
      for (Map.Entry<String, CelVerificationResult> e : results.entrySet()) {
        if (!first) {
          sb.append(',');
        }
        first = false;
        sb.append("{\"id\":\"").append(FormatUtils.escapeJson(e.getKey())).append("\",\"result\":");
        sb.append(ok(e.getValue())).append('}');
      }
      return sb.append("]}").toString();
    } catch (Throwable t) {
      return fail(t);
    }
  }

  public static String policyEquiv(
      String yamlA, String yamlB, String varSpecs, int timeoutMs, int unroll, String unknowns) {
    try {
      return ok(
          CelVerifierToolCore.verifyPolicyEquivalence(
              yamlA, yamlB, vars(varSpecs), options(timeoutMs, unroll, unknowns)));
    } catch (Throwable t) {
      return fail(t);
    }
  }

  /** Cheap liveness check for the loader. */
  public static String ping() {
    return "pong " + Arrays.toString(new int[] {1, 2, 3});
  }
}
