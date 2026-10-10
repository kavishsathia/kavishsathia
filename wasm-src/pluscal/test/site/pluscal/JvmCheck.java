// Copyright 2026 Kavish Sathia. Apache-2.0.
//
// Drives PlusCalWeb on a real JVM the way the page does, and checks the
// answers: translation, a passing model, an invariant violation with a
// trace, a deadlock, a translator error, back-to-back runs, and stop().
package site.pluscal;

import java.util.ArrayList;
import java.util.List;

public final class JvmCheck {
  private static int failures = 0;

  private static void expect(boolean cond, String what, String detail) {
    System.out.println((cond ? "  ok   " : "  FAIL ") + what);
    if (!cond) {
      failures++;
      System.out.println(detail);
    }
  }

  static final String PETERSON = String.join("\n",
      "---- MODULE Peterson ----",
      "EXTENDS TLC, Naturals",
      "(* --algorithm Peterson",
      "variables flag = [i \\in {0, 1} |-> FALSE], turn = 0;",
      "process P \\in {0, 1}",
      "begin",
      "a1: while TRUE do",
      "  a2: flag[self] := TRUE;",
      "  a3: turn := 1 - self;",
      "  a4: await ~flag[1 - self] \\/ turn = self;",
      "  cs: skip;",
      "  a5: flag[self] := FALSE;",
      "  end while;",
      "end process;",
      "end algorithm; *)",
      "MutualExclusion == ~(pc[0] = \"cs\" /\\ pc[1] = \"cs\")",
      "====", "");

  private static List<String> lines = new ArrayList<>();
  private static volatile boolean stopFlag = false;

  private static String run(String name, String tla, String cfg, String args) {
    lines = new ArrayList<>();
    long t0 = System.nanoTime();
    String r = PlusCalWeb.check(name, tla, cfg, args);
    System.out.printf("  (%s: %d ms, %d lines)%n", name, (System.nanoTime() - t0) / 1_000_000, lines.size());
    return r;
  }

  private static String out() {
    return String.join("\n", lines);
  }

  private static String translated(String r) {
    // The facade's JSON; pull the "tla" field out without a JSON library.
    int i = r.indexOf("\"tla\":\"") + 7;
    StringBuilder b = new StringBuilder();
    for (; i < r.length(); i++) {
      char c = r.charAt(i);
      if (c == '"') break;
      if (c == '\\') {
        char n = r.charAt(++i);
        b.append(n == 'n' ? '\n' : n == 't' ? '\t' : n == 'r' ? '\r' : n);
      } else {
        b.append(c);
      }
    }
    return b.toString();
  }

  public static void main(String[] a) throws Exception {
    PlusCalWeb.configure(a[0], a[1], a[2]);
    PlusCalWeb.lineSink = line -> lines.add(line);
    PlusCalWeb.stopSignal = () -> stopFlag;
    final String tool = "-tool\n-workers\n1\n-noGenerateSpecTE";

    System.out.println("translate");
    String tr = PlusCalWeb.translate("Peterson", PETERSON, "");
    expect(tr.contains("\"status\":0") && tr.contains("BEGIN TRANSLATION") && tr.contains("SPECIFICATION Spec"),
        "Peterson translates; .cfg names Spec", tr);
    String tla = translated(tr);

    System.out.println("check: Peterson is mutually exclusive");
    String r = run("Peterson", tla, "SPECIFICATION Spec\nINVARIANT MutualExclusion\n", tool);
    expect(r.equals("{\"ok\":true,\"status\":0}") && out().contains("Model checking completed. No error has been found."),
        "no error, exit 0", r + "\n" + out());
    expect(out().contains("@!@!@STARTMSG 2193:0 @!@!@") && out().contains("42 distinct states found"),
        "-tool framing; 42 distinct states (same as the CLI)", out());

    System.out.println("check: without the await, mutual exclusion fails");
    String broken = PETERSON.replace("  a4: await ~flag[1 - self] \\/ turn = self;\n", "");
    String tr2 = PlusCalWeb.translate("Peterson", broken, "");
    r = run("Peterson", translated(tr2), "SPECIFICATION Spec\nINVARIANT MutualExclusion\n", tool);
    expect(r.equals("{\"ok\":true,\"status\":12}") && out().contains("Invariant MutualExclusion is violated."),
        "violation, exit 12 (EC.ExitStatus.VIOLATION_SAFETY)", r + "\n" + out());
    expect(out().contains("@!@!@STARTMSG 2217:4 @!@!@"), "trace states in -tool framing", out());

    System.out.println("check: deadlock");
    String dl = String.join("\n", "---- MODULE Dead ----", "EXTENDS Naturals",
        "(* --algorithm Dead", "variable x = 0;", "begin", "  a: x := 1;", "  b: await x = 2;",
        "end algorithm; *)", "====", "");
    r = run("Dead", translated(PlusCalWeb.translate("Dead", dl, "")), "SPECIFICATION Spec\n", tool);
    expect(r.equals("{\"ok\":true,\"status\":11}") && out().contains("Deadlock reached."),
        "deadlock, exit 11", r + "\n" + out());

    System.out.println("translate: syntax error");
    String bad = PlusCalWeb.translate("Bad", PETERSON.replace("end while;", "end whilst;").replace("Peterson", "Bad"), "");
    expect(bad.contains("\"ok\":true") && !bad.contains("\"status\":0") && bad.contains("\"tla\":null"),
        "non-zero status, messages kept", bad);
    System.out.println("    " + bad.substring(bad.indexOf("\"messages\"")));

    System.out.println("check: SANY error in the TLA+");
    r = run("Peterson", tla.replace("MutualExclusion ==", "MutualExclusion == undefinedOp /\\"),
        "SPECIFICATION Spec\nINVARIANT MutualExclusion\n", tool);
    expect(r.contains("\"ok\":true") && !r.contains("\"status\":0") && out().contains("Unknown operator: `undefinedOp'"),
        "semantic error reported, non-zero exit", r + "\n" + out());

    System.out.println("check: Community Modules (Java-overridden operators)");
    String cm = String.join("\n", "---- MODULE Comm ----",
        "EXTENDS Naturals, Sequences, SequencesExt, FiniteSetsExt, Functions",
        "VARIABLE s", "Init == s = <<3, 1, 2>>", "Next == UNCHANGED s",
        "Ok == /\\ ToSet(s) = {1, 2, 3} /\\ SetToSeq({7}) = <<7>>",
        "      /\\ FoldSet(+, 0, {1, 2, 3}) = 6 /\\ Range([i \\in 1..2 |-> i * 10]) = {10, 20}",
        "      /\\ ReplaceAll(<<1, 2, 1>>, 1, 9) = <<9, 2, 9>>",
        "Spec == Init /\\ [][Next]_s", "====", "");
    r = run("Comm", cm, "SPECIFICATION Spec\nINVARIANT Ok\n", tool);
    expect(r.equals("{\"ok\":true,\"status\":0}"), "SequencesExt/FiniteSetsExt/Functions resolve and hold", r + "\n" + out());

    System.out.println("stop: a large state space, stopped after 1.5 s");
    String big = String.join("\n", "---- MODULE Big ----", "EXTENDS Naturals",
        "VARIABLES x, y, z", "Init == x = 0 /\\ y = 0 /\\ z = 0",
        "Next == \\/ x' = (x + 1) % 1000 /\\ UNCHANGED <<y, z>>",
        "        \\/ y' = (y + 1) % 1000 /\\ UNCHANGED <<x, z>>",
        "        \\/ z' = (z + 1) % 1000 /\\ UNCHANGED <<x, y>>",
        "Spec == Init /\\ [][Next]_<<x, y, z>>", "====", "");
    Thread stopper = new Thread(() -> {
      try { Thread.sleep(1500); } catch (InterruptedException e) { }
      stopFlag = true;
      System.out.println("    stop requested");
    });
    stopper.start();
    long t0 = System.nanoTime();
    r = run("Big", big, "SPECIFICATION Spec\n", tool);
    long ms = (System.nanoTime() - t0) / 1_000_000;
    expect(r.contains("\"ok\":true") && ms < 10_000, "returns promptly after stop (" + ms + " ms)", r + "\n" + out());
    stopper.join();

    System.out.println(failures == 0 ? "all JVM checks passed" : failures + " JVM check(s) FAILED");
    System.exit(failures == 0 ? 0 : 1);
  }
}
