using System.Runtime.InteropServices.JavaScript;
using System.Text;
using Microsoft.Boogie;
using Microsoft.Boogie.SMTLib;
using SMTLib;

namespace DafnyWasm;

/// <summary>
/// JS-side Z3: each context id maps to a Z3 context in the wasm build, and
/// eval feeds SMT-LIB2 command text through Z3_eval_smtlib2_string, which
/// keeps solver state between calls (that's what makes push/pop work).
/// </summary>
public static partial class Z3Interop
{
    [JSImport("z3.createContext", "main.js")]
    internal static partial int CreateContext();

    [JSImport("z3.evalSmtlib", "main.js")]
    internal static partial Task<string> Eval(int ctx, string smt);

    [JSImport("z3.disposeContext", "main.js")]
    internal static partial void DisposeContext(int ctx);
}

/// <summary>
/// Boogie talks to Z3 through an abstract SMTLibSolver; the stock
/// implementation spawns a z3 process and pipes SMT-LIB text. This one buffers
/// commands and flushes them through the wasm Z3 on each request, mirroring
/// SMTLibProcess semantics: responses come back in order, the last response
/// before end-of-output answers the request, earlier ones are errors.
/// </summary>
public class Z3WasmSolver : SMTLibSolver
{
    private readonly StringBuilder buffer = new();
    private readonly SemaphoreSlim requestLock = new(1);
    private int contextId;
    private bool closed;

#pragma warning disable CS0067
    public override event Action<string> ErrorHandler;
#pragma warning restore CS0067

    public Z3WasmSolver()
    {
        contextId = Z3Interop.CreateContext();
    }

    public override void Close()
    {
        if (!closed)
        {
            closed = true;
            Z3Interop.DisposeContext(contextId);
        }
    }

    public override void Send(string cmd)
    {
        lock (buffer)
        {
            buffer.AppendLine(cmd);
        }
    }

    private async Task<List<SExpr>> Flush(string request)
    {
        string batch;
        lock (buffer)
        {
            if (request != null)
            {
                buffer.AppendLine(request);
            }
            batch = buffer.ToString();
            buffer.Clear();
        }

        var outText = await Z3Interop.Eval(contextId, batch);

        var parser = new SExprParser();
        parser.ErrorHandler += msg => ErrorHandler?.Invoke(msg);
        foreach (var line in outText.Split('\n'))
        {
            parser.AddLine(line);
        }
        parser.AddLine(null); // end-of-output

        var result = new List<SExpr>();
        await foreach (var sexpr in parser.ParseSExprs(true))
        {
            result.Add(sexpr);
        }
        return result;
    }

    public override async Task<SExpr> SendRequest(string request, CancellationToken cancellationToken = default)
    {
        await requestLock.WaitAsync(cancellationToken);
        try
        {
            var responses = await Flush(request);
            if (responses.Count == 0)
            {
                throw new ProverDiedException();
            }
            // Mirror SMTLibProcess: the last response answers the request;
            // anything before it is an error from a buffered command.
            for (var i = 0; i < responses.Count - 1; i++)
            {
                ErrorHandler?.Invoke(responses[i].ToString());
            }
            return responses[^1];
        }
        finally
        {
            requestLock.Release();
        }
    }

    public override async Task<IReadOnlyList<SExpr>> SendRequestsAndCloseInput(
        IReadOnlyList<string> requests, CancellationToken cancellationToken = default)
    {
        await requestLock.WaitAsync(cancellationToken);
        try
        {
            foreach (var request in requests)
            {
                Send(request);
            }
            return await Flush(null);
        }
        finally
        {
            requestLock.Release();
        }
    }

    public override void NewProblem(string descriptiveName)
    {
    }

    public override async Task PingPong()
    {
        var response = await SendRequest(PingRequest);
        if (!IsPong(response))
        {
            throw new ProverDiedException();
        }
    }

    public override void AddErrorHandler(Action<string> handler)
    {
        ErrorHandler += handler;
    }
}
