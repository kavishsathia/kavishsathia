// Copyright 2026 Kavish Sathia. Apache-2.0.
//
// Browser entry point for the CEL verifier. Lives in the tools package so it
// can reuse CelVerifierToolCore and VerificationOptions exactly as the REPL
// does; the only thing it adds is a JSON envelope for JavaScript.
package dev.cel.verifier.tools;

import com.google.common.collect.ImmutableMap;
import dev.cel.common.CelAbstractSyntaxTree;
import dev.cel.common.CelOptions;
import dev.cel.common.CelValidationException;
import dev.cel.common.types.CelType;
import dev.cel.common.types.SimpleType;
import dev.cel.compiler.CelCompiler;
import dev.cel.extensions.CelExtensions;
import dev.cel.runtime.CelEvaluationException;
import dev.cel.runtime.CelRuntime;
import dev.cel.runtime.CelRuntimeFactory;
import dev.cel.verifier.CelVerificationResult;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

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

  /** The runtime half of the verifier's environment: the same extensions, evaluated. */
  private static CelRuntime runtime() {
    return CelRuntimeFactory.plannerRuntimeBuilder()
        .addLibraries(
            CelExtensions.encoders(CelOptions.DEFAULT),
            CelExtensions.lists(),
            CelExtensions.math(),
            CelExtensions.optional(),
            CelExtensions.regex(),
            CelExtensions.sets(CelOptions.DEFAULT),
            CelExtensions.strings(),
            CelExtensions.comprehensions())
        .build();
  }

  /**
   * Evaluates boolean expressions against one concrete input with cel-java's runtime — no solver.
   *
   * <p>{@code bindings} holds {@code name U+001F literal} entries separated by U+001E; each
   * literal is itself a CEL expression with no variables, compiled against the declared type of
   * its field (so {@code 5} is not accepted for a {@code double}). Every declared variable must be
   * bound exactly once and nothing else may be. {@code expressions} are separated by U+001E and
   * are compiled with the same compiler the verifier uses.
   */
  public static String evaluate(String varSpecs, String bindings, String expressions) {
    try {
      ImmutableMap<String, CelType> declared = vars(varSpecs);
      CelRuntime runtime = runtime();
      CelCompiler literalCompiler = CelVerifierToolCore.buildCompiler(ImmutableMap.of());
      Map<String, Object> activation = new LinkedHashMap<>();
      Set<String> seen = new HashSet<>();
      List<String> inputErrors = new ArrayList<>();
      for (String entry : bindings.isEmpty() ? new String[0] : bindings.split("\u001e", -1)) {
        int sep = entry.indexOf('\u001f');
        String name = sep < 0 ? entry : entry.substring(0, sep);
        String literal = sep < 0 ? "" : entry.substring(sep + 1);
        CelType type = declared.get(name);
        if (type == null) {
          inputErrors.add(inputError(name, "not a declared field"));
        } else if (!seen.add(name)) {
          inputErrors.add(inputError(name, "bound more than once"));
        } else if (literal.trim().isEmpty()) {
          inputErrors.add(inputError(name, "missing value"));
        } else {
          try {
            CelAbstractSyntaxTree ast =
                literalCompiler.toCompilerBuilder().setResultType(type).build().compile(literal).getAst();
            activation.put(name, runtime.createProgram(ast).eval(ImmutableMap.of()));
          } catch (CelValidationException e) {
            inputErrors.add(inputError(name, e.getMessage()));
          } catch (CelEvaluationException e) {
            inputErrors.add(inputError(name, describe(e)));
          }
        }
      }
      for (String name : declared.keySet()) {
        if (!seen.contains(name)) {
          inputErrors.add(inputError(name, "missing value"));
        }
      }

      StringBuilder sb = new StringBuilder("{\"ok\":true,\"inputErrors\":[");
      sb.append(String.join(",", inputErrors)).append("],\"results\":[");
      if (inputErrors.isEmpty()) {
        CelCompiler compiler = CelVerifierToolCore.buildCompiler(declared);
        boolean first = true;
        for (String expression : expressions.split("\u001e", -1)) {
          if (!first) {
            sb.append(',');
          }
          first = false;
          sb.append(evaluateOne(compiler, runtime, expression, activation));
        }
      }
      return sb.append("]}").toString();
    } catch (Throwable t) {
      return fail(t);
    }
  }

  private static String inputError(String field, String error) {
    return "{\"field\":\""
        + FormatUtils.escapeJson(field)
        + "\",\"error\":\""
        + FormatUtils.escapeJson(error)
        + "\"}";
  }

  private static String evaluateOne(
      CelCompiler compiler, CelRuntime runtime, String expression, Map<String, Object> activation) {
    CelAbstractSyntaxTree ast;
    try {
      ast = compiler.compile(expression).getAst();
    } catch (CelValidationException e) {
      return "{\"ok\":false,\"kind\":\"compile\",\"error\":\"" + FormatUtils.escapeJson(e.getMessage()) + "\"}";
    }
    if (!ast.getResultType().equals(SimpleType.BOOL)) {
      return "{\"ok\":false,\"kind\":\"type\",\"error\":\"expression has type "
          + FormatUtils.escapeJson(ast.getResultType().toString())
          + ", not bool\"}";
    }
    try {
      Object value = runtime.createProgram(ast).eval(activation);
      if (!(value instanceof Boolean)) {
        return "{\"ok\":false,\"kind\":\"eval\",\"error\":\"evaluated to a non-bool value: "
            + FormatUtils.escapeJson(String.valueOf(value))
            + "\"}";
      }
      return "{\"ok\":true,\"value\":" + value + "}";
    } catch (CelEvaluationException e) {
      return "{\"ok\":false,\"kind\":\"eval\",\"error\":\"" + FormatUtils.escapeJson(describe(e)) + "\"}";
    }
  }

  /** The runtime's message, plus its cause when the message doesn't already say it. */
  private static String describe(CelEvaluationException e) {
    String message = e.getMessage() == null ? "" : e.getMessage();
    Throwable cause = e.getCause();
    if (cause != null && (cause.getMessage() == null || !message.contains(cause.getMessage()))) {
      message += " (" + cause + ")";
    }
    return message;
  }

  /** Cheap liveness check for the loader. */
  public static String ping() {
    return "pong " + Arrays.toString(new int[] {1, 2, 3});
  }
}
