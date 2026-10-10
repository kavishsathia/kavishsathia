// Copyright 2026 Kavish Sathia. Apache-2.0.
//
// Runs inside a classloader of its own together with the unmodified
// tla2tools.jar (see PlusCalWeb), so every run starts from TLC's and the
// translator's initial static state. Does what pcal.trans.main and
// tlc2.TLC.main do, minus System.exit; all output is routed to a sink.
package site.pluscal.runner;

import java.io.OutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.function.Consumer;

import tlc2.TLC;
import tlc2.TLCGlobals;
import util.SimpleFilenameToStream;
import util.ToolIO;

public final class PlusCalRunner {
  private PlusCalRunner() {}

  /** Splits a byte stream into lines and hands each one to the sink. */
  private static final class LineSink extends OutputStream {
    private final Consumer<String> sink;
    private final java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();

    LineSink(Consumer<String> sink) {
      this.sink = sink;
    }

    @Override
    public synchronized void write(int b) {
      if (b == '\n') {
        flushLine();
      } else if (b != '\r') {
        buf.write(b);
      }
    }

    @Override
    public synchronized void write(byte[] b, int off, int len) {
      for (int i = off; i < off + len; i++) {
        write(b[i]);
      }
    }

    @Override
    public synchronized void flush() {
      // Lines are emitted when complete; a trailing partial line on close.
    }

    @Override
    public synchronized void close() {
      if (buf.size() > 0) {
        flushLine();
      }
    }

    private void flushLine() {
      sink.accept(new String(buf.toByteArray(), StandardCharsets.UTF_8));
      buf.reset();
    }
  }

  /**
   * pcal.trans on {@code dir/name.tla}, which it rewrites in place (and
   * writes {@code name.cfg} beside it, as the CLI does). Tool mode makes
   * the translator return instead of exiting and keep its messages.
   *
   * @return the translator's status (0 = ok), then its messages
   */
  public static String[] translate(String dir, String name, String[] options) throws Exception {
    ToolIO.setMode(ToolIO.TOOL);
    ToolIO.reset();
    ToolIO.setUserDir(dir);
    // The translator opens its input with new File(...), so the path is absolute.
    String[] args = new String[options.length + 1];
    System.arraycopy(options, 0, args, 0, options.length);
    args[options.length] = dir + "/" + name + ".tla";
    // pcal.trans is package-private; the CLI reaches it through main.
    java.lang.reflect.Method runMe = Class.forName("pcal.trans").getMethod("runMe", String[].class);
    runMe.setAccessible(true);
    int status = (Integer) runMe.invoke(null, (Object) args);
    String[] messages = ToolIO.getAllMessages();
    String[] out = new String[messages.length + 1];
    out[0] = Integer.toString(status);
    System.arraycopy(messages, 0, out, 1, messages.length);
    return out;
  }

  /**
   * TLC on {@code dir/name.tla}, as tlc2.TLC.main runs it: parse the
   * arguments, resolve modules from the spec's directory (and the standard
   * modules in the jar), process. Output, in -tool message framing when the
   * caller asks for it, goes line by line to {@code sink}.
   *
   * @return TLC's exit status (EC.ExitStatus), or -1 if the arguments were rejected
   */
  public static int check(String dir, String[] args, Consumer<String> sink) {
    PrintStream ps = new PrintStream(new LineSink(sink), true, StandardCharsets.UTF_8);
    ToolIO.out = ps;
    ToolIO.err = ps;
    try {
      TLC tlc = new TLC();
      if (!tlc.handleParameters(args)) {
        return -1;
      }
      tlc.setResolver(new SimpleFilenameToStream(dir));
      int errorCode = tlc.process();
      return tlc2.output.EC.ExitStatus.errorConstantToExitStatus(errorCode);
    } finally {
      ps.close();
    }
  }

  /** Asks a running model checker or simulator to stop after its current step. */
  public static void stop() {
    if (TLCGlobals.mainChecker != null) {
      TLCGlobals.mainChecker.stop();
    }
    if (TLCGlobals.simulator != null) {
      TLCGlobals.simulator.stop();
    }
  }
}
