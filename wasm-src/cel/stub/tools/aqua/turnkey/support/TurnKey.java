package tools.aqua.turnkey.support;

import java.util.function.Function;

/**
 * Browser stand-in for the z3-turnkey native-library loader. The real class
 * extracts libz3 from the jar and System.load()s it; here the Z3 natives are
 * implemented in JavaScript, so loading is a no-op.
 */
public final class TurnKey {
  private TurnKey() {}

  public static void load(String path, Function<String, Object> resourceLoader) {}
}
