// Copyright 2026 Kavish Sathia. Apache-2.0.
//
// Browser entry point for the PlusCal tool. JavaScript calls these static
// methods through CheerpJ's library mode. Every call gets a fresh
// classloader over the unmodified tla2tools.jar plus PlusCalRunner, because
// the translator and TLC keep their state in statics and were written to run
// once per process. Spec files live in CheerpJ's writable /files/ mount.
package site.pluscal;

import java.io.File;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

public final class PlusCalWeb {
  private PlusCalWeb() {}

  /** Implemented in JavaScript: one line of tool output. */
  private static native void emit(String line);

  /**
   * Implemented in JavaScript: whether the page asked the run to stop.
   * CheerpJ runs one library call at a time, so the page cannot call into
   * Java while check() is running; instead a watchdog polls this.
   */
  private static native boolean stopRequested();

  /** Where TLC's output lines go; the JVM test harness swaps this out. */
  static Consumer<String> lineSink = PlusCalWeb::emit;
  /** Where stop requests come from; likewise. */
  static BooleanSupplier stopSignal = PlusCalWeb::stopRequested;

  private static String toolsJar = "/app/pluscal/tla2tools.jar";
  private static String runnerJar = "/app/pluscal/pluscal-runner.jar";
  private static String workRoot = "/files/pluscal";

  private static int runCounter = 0;
  /** The loader of the run in progress, so stop() can reach its TLC. */
  private static volatile ClassLoader current;

  public static String ping() {
    return "ok";
  }

  /** Overrides the default locations (used by the JVM test harness). */
  public static void configure(String tools, String runner, String work) {
    toolsJar = tools;
    runnerJar = runner;
    workRoot = work;
  }

  /**
   * TLC's documented opt-out from execution statistics: ~/.tlaplus/esc.txt
   * holding NO_STATISTICS. (Without the file TLC sends nothing either; this
   * makes the choice explicit and robust to that default changing.)
   */
  private static void optOutOfStatistics() throws Exception {
    Path esc = Paths.get(System.getProperty("user.home", ""), ".tlaplus", "esc.txt");
    if (!Files.exists(esc)) {
      Files.createDirectories(esc.getParent());
      Files.write(esc, "NO_STATISTICS\n".getBytes(StandardCharsets.UTF_8));
    }
  }

  private static ClassLoader freshLoader() throws Exception {
    optOutOfStatistics();
    URL[] urls = {new File(toolsJar).toURI().toURL(), new File(runnerJar).toURI().toURL()};
    return new URLClassLoader(urls, ClassLoader.getPlatformClassLoader());
  }

  private static Method runner(ClassLoader cl, String name, Class<?>... types) throws Exception {
    return cl.loadClass("site.pluscal.runner.PlusCalRunner").getMethod(name, types);
  }

  /** A new, empty directory for one run, holding name.tla (and name.cfg). */
  private static Path workDir(String name, String tla, String cfg) throws Exception {
    Path dir = Paths.get(workRoot, "run" + (++runCounter));
    if (Files.exists(dir)) {
      deleteTree(dir);
    }
    Files.createDirectories(dir);
    Files.write(dir.resolve(name + ".tla"), tla.getBytes(StandardCharsets.UTF_8));
    if (cfg != null) {
      Files.write(dir.resolve(name + ".cfg"), cfg.getBytes(StandardCharsets.UTF_8));
    }
    // Keep only the previous run's directory around.
    Path old = Paths.get(workRoot, "run" + (runCounter - 2));
    if (Files.exists(old)) {
      deleteTree(old);
    }
    return dir;
  }

  private static void deleteTree(Path p) throws Exception {
    if (Files.isDirectory(p)) {
      try (var s = Files.list(p)) {
        for (Path c : (Iterable<Path>) s::iterator) {
          deleteTree(c);
        }
      }
    }
    Files.deleteIfExists(p);
  }

  private static String read(Path p) throws Exception {
    return Files.exists(p) ? new String(Files.readAllBytes(p), StandardCharsets.UTF_8) : null;
  }

  private static List<String> lines(String s) {
    List<String> out = new ArrayList<>();
    for (String line : s.split("\n")) {
      String t = line.trim();
      if (!t.isEmpty()) {
        out.add(t);
      }
    }
    return out;
  }

  private static Throwable unwrap(Throwable t) {
    return t instanceof InvocationTargetException && t.getCause() != null ? t.getCause() : t;
  }

  /**
   * Runs the PlusCal translator over a module, exactly as {@code java
   * pcal.trans [options] name.tla} would.
   *
   * @param options translator options, one per line (e.g. -nocfg, -label)
   * @return JSON: status, the rewritten module, the generated .cfg, and the translator's messages
   */
  public static String translate(String name, String tla, String options) {
    try {
      Path dir = workDir(name, tla, null);
      ClassLoader cl = freshLoader();
      String[] res = (String[]) runner(cl, "translate", String.class, String.class, String[].class)
          .invoke(null, dir.toString(), name, lines(options).toArray(new String[0]));
      StringBuilder msgs = new StringBuilder("[");
      for (int i = 1; i < res.length; i++) {
        if (i > 1) {
          msgs.append(',');
        }
        msgs.append('"').append(Json.escape(res[i])).append('"');
      }
      msgs.append(']');
      int status = Integer.parseInt(res[0]);
      return "{\"ok\":true,\"status\":" + status
          + ",\"tla\":" + Json.str(status == 0 ? read(dir.resolve(name + ".tla")) : null)
          + ",\"cfg\":" + Json.str(status == 0 ? read(dir.resolve(name + ".cfg")) : null)
          + ",\"messages\":" + msgs + "}";
    } catch (Throwable t) {
      return Json.failure(unwrap(t));
    }
  }

  /**
   * Model-checks (or simulates) a module with TLC, exactly as {@code java
   * tlc2.TLC [args] name.tla} would, with {@code -config name.cfg} and a
   * states directory under the run's own folder. Output streams through
   * {@link #emit}; when {@code args} contains -tool it is in the Toolbox's
   * message framing. A stop request (see {@link #stopRequested}) ends the
   * run the way the Toolbox's stop button does.
   *
   * @param args further TLC arguments, one per line
   * @return JSON: TLC's exit status
   */
  public static String check(String name, String tla, String cfg, String args) {
    try {
      Path dir = workDir(name, tla, cfg);
      List<String> argv = new ArrayList<>(lines(args));
      argv.add("-config");
      argv.add(dir.resolve(name + ".cfg").toString());
      argv.add("-metadir");
      argv.add(dir.resolve("states").toString());
      argv.add(dir.resolve(name + ".tla").toString());
      ClassLoader cl = freshLoader();
      current = cl;
      Consumer<String> sink = lineSink;
      int status = (Integer) runner(cl, "check", String.class, String[].class, Consumer.class)
          .invoke(null, dir.toString(), argv.toArray(new String[0]), sink);
      return "{\"ok\":true,\"status\":" + status + "}";
    } catch (Throwable t) {
      return Json.failure(unwrap(t));
    } finally {
      current = null;
    }
  }

  private static Thread watchdog;

  static {
    watchdog = new Thread(() -> {
      while (true) {
        try {
          Thread.sleep(200);
        } catch (InterruptedException e) {
          return;
        }
        if (current != null && stopSignal.getAsBoolean()) {
          stop();
        }
      }
    }, "pluscal-stop-watchdog");
    watchdog.setDaemon(true);
    watchdog.start();
  }

  /** Stops the run in progress, if any. */
  static String stop() {
    ClassLoader cl = current;
    if (cl == null) {
      return "idle";
    }
    try {
      runner(cl, "stop").invoke(null);
      return "stopping";
    } catch (Throwable t) {
      return Json.failure(unwrap(t));
    }
  }
}
