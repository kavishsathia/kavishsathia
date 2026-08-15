using System.Reflection;
using System.Runtime.InteropServices.JavaScript;
using System.Text;
using System.Text.Json;
using Microsoft.Dafny;

namespace DafnyWasm;

public sealed class CheckResult
{
    public bool Ok { get; set; }
    public string Error { get; set; }
    public string Crash { get; set; }
    public string Diagnostics { get; set; }
}

public sealed class VerifyResult
{
    public bool Ok { get; set; }
    public string Error { get; set; }
    public string Crash { get; set; }
    public string Diagnostics { get; set; }
    public string Outcome { get; set; }
    public int VerifiedCount { get; set; }
    public int ErrorCount { get; set; }
    public int InconclusiveCount { get; set; }
    public int TimeoutCount { get; set; }
}

[System.Text.Json.Serialization.JsonSerializable(typeof(CheckResult))]
[System.Text.Json.Serialization.JsonSerializable(typeof(VerifyResult))]
internal partial class DafnyJsonContext : System.Text.Json.Serialization.JsonSerializerContext
{
}

/// <summary>
/// DafnyOptions captures its output writer at construction, but we keep one
/// options/engine pair alive across calls (each ExecutionEngine spins up
/// dedicated threads, and wasm can't keep paying that) — so the writer the
/// options hold delegates to a per-call target.
/// </summary>
public sealed class SwappableWriter : TextWriter
{
    public TextWriter Target { get; set; } = TextWriter.Null;
    public override Encoding Encoding => Encoding.UTF8;
    public override void Write(char value) => Target.Write(value);
    public override void Write(string value) => Target.Write(value);
    public override void WriteLine(string value) => Target.WriteLine(value);
}

public partial class DafnyHost
{
    private static string preludePath;
    private static readonly SwappableWriter OutputSink = new();
    private static readonly StringWriter ParseErrorSink = new();
    private static DafnyOptions options;
    private static Microsoft.Boogie.ExecutionEngine engine;

    public static void Main()
    {
        // wasm has no real console; Dafny touches Console.In/Out lazily
        // (e.g. DafnyOptions.DefaultImmutableOptions), which would throw
        // PlatformNotSupportedException.
        Console.SetIn(TextReader.Null);
        Console.SetOut(TextWriter.Null);
        Console.SetError(TextWriter.Null);
        // The runtime stays alive for JSExport calls after Main returns.
    }

    private static void EnsurePrelude()
    {
        if (preludePath != null)
        {
            return;
        }
        Directory.CreateDirectory("/work");
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("DafnyPrelude.bpl");
        using var file = File.Create("/work/DafnyPrelude.bpl");
        stream!.CopyTo(file);
        preludePath = "/work/DafnyPrelude.bpl";
    }

    private static void EnsureEngine()
    {
        if (engine != null)
        {
            return;
        }
        EnsurePrelude();

        options = new DafnyOptions(TextReader.Null, OutputSink, ParseErrorSink);
        // Must precede Parse: with no factory set, ApplyDefaultOptions calls
        // ProverFactory.Load, which builds a path from Assembly.Location —
        // empty under wasm — and throws, aborting the rest of the defaults.
        options.TheProverFactory = new Microsoft.Boogie.SMTLib.Factory();
        options.Parse(new[] { "/compile:0", "/diagnosticsFormat:json", "/timeLimit:15" });
        options.DafnyPrelude = preludePath;
        options.VcsCores = 1;
        // Route Boogie's solver connection to the wasm Z3 instead of a z3
        // subprocess, and configure the Z3 options Dafny wants without
        // probing for a binary on disk.
        options.CreateSolver = (_, _) => new Z3WasmSolver();
        options.SetZ3Options(new Version(4, 12, 1));

        engine = Microsoft.Boogie.ExecutionEngine.CreateWithoutSharedCache(options);
    }

    private static async Task<(Program Program, string Error)> ParseAndResolve(string source)
    {
        File.WriteAllText("/work/input.dfy", source);
        var reporter = new ConsoleErrorReporter(options);
        var uri = new Uri("file:///work/input.dfy");
        var files = new List<DafnyFile>();
        await foreach (var f in DafnyFile.CreateAndValidate(
            OnDiskFileSystem.Instance, reporter, options, uri, Token.Cli))
        {
            files.Add(f);
        }
        return await DafnyMain.ParseCheck(TextReader.Null, files, "input", options);
    }

    [JSExport]
    internal static async Task<string> Check(string source)
    {
        var output = new StringWriter();
        try
        {
            EnsureEngine();
            OutputSink.Target = output;
            var (_, err) = await ParseAndResolve(source);
            return JsonSerializer.Serialize(new CheckResult
            {
                Ok = err == null,
                Error = err,
                Diagnostics = output.ToString(),
            }, DafnyJsonContext.Default.CheckResult);
        }
        catch (Exception e)
        {
            return JsonSerializer.Serialize(new CheckResult
            {
                Ok = false,
                Crash = e.ToString(),
                Diagnostics = output.ToString(),
            }, DafnyJsonContext.Default.CheckResult);
        }
        finally
        {
            OutputSink.Target = TextWriter.Null;
        }
    }

    [JSExport]
    internal static async Task<string> Verify(string source)
    {
        var output = new StringWriter();
        try
        {
            EnsureEngine();
            OutputSink.Target = output;

            var (program, err) = await ParseAndResolve(source);
            if (err != null)
            {
                return JsonSerializer.Serialize(new VerifyResult
                {
                    Ok = false,
                    Error = err,
                    Diagnostics = output.ToString(),
                }, DafnyJsonContext.Default.VerifyResult);
            }

            var boogiePrograms = await DafnyMain.LargeStackFactory.StartNew(() =>
                Microsoft.Dafny.BoogieGenerator.Translate(program, program.Reporter).ToList());

            var reporter = new ConsoleErrorReporter(options);
            var verified = 0;
            var errors = 0;
            var inconclusive = 0;
            var timeouts = 0;
            var outcomeName = "VerificationCompleted";

            foreach (var (moduleName, boogieProgram) in boogiePrograms)
            {
                var (outcome, stats) = await DafnyMain.LargeStackFactory.StartNew(() =>
                    DafnyMain.BoogieOnce(reporter, options, output, engine,
                        "input.dfy", moduleName, boogieProgram, "main_program_id")).Unwrap();
                verified += stats.VerifiedCount;
                errors += stats.ErrorCount;
                inconclusive += stats.InconclusiveCount;
                timeouts += stats.TimeoutCount;
                if (outcome != Microsoft.Boogie.PipelineOutcome.Done &&
                    outcome != Microsoft.Boogie.PipelineOutcome.VerificationCompleted)
                {
                    outcomeName = outcome.ToString();
                }
            }

            return JsonSerializer.Serialize(new VerifyResult
            {
                Ok = errors == 0 && inconclusive == 0 && timeouts == 0,
                Diagnostics = output.ToString(),
                Outcome = outcomeName,
                VerifiedCount = verified,
                ErrorCount = errors,
                InconclusiveCount = inconclusive,
                TimeoutCount = timeouts,
            }, DafnyJsonContext.Default.VerifyResult);
        }
        catch (Exception e)
        {
            return JsonSerializer.Serialize(new VerifyResult
            {
                Ok = false,
                Crash = e.ToString(),
                Diagnostics = output.ToString(),
            }, DafnyJsonContext.Default.VerifyResult);
        }
        finally
        {
            OutputSink.Target = TextWriter.Null;
        }
    }

    /// <summary>Bisection helper: parse '|'-separated legacy args, report everything.</summary>
    [JSExport]
    internal static Task<string> DebugParseAsync(string argsJoined)
    {
        return Task.FromResult(DebugParse(argsJoined));
    }

    internal static string DebugParse(string argsJoined)
    {
        var outW = new StringWriter();
        var errW = new StringWriter();
        var o = new DafnyOptions(TextReader.Null, outW, errW);
        bool ok;
        var exc = "";
        try
        {
            if (argsJoined == "@apply")
            {
                o.ApplyDefaultOptions();
                ok = true;
            }
            else
            {
                var args = argsJoined.Length == 0 ? Array.Empty<string>() : argsJoined.Split('|');
                ok = o.Parse(args);
            }
        }
        catch (Exception e)
        {
            ok = false;
            exc = e.ToString();
        }
        return $"ok={ok} exc={exc} out=[{outW}] err=[{errW}]";
    }
}
