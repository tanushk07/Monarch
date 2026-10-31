// Adds three hooks to Monarch.exe that call MonarchMouse.dll. Nothing else in the exe changes.
//
//   MouseDevice.Start()  ends by calling     Hooks.Started(this)
//   App.MouseState()     returns             Hooks.State(<its dictionary>, this)
//   App.Call(m, a)       first asks          Hooks.Call(this, m, a), and returns that task if it isn't null
//
// usage: Patcher <unpatched Monarch.exe> <MonarchMouse.dll> <output Monarch.exe>
//        Patcher --refs <assembly>          (lists an assembly's references, for checking)

using Mono.Cecil;
using Mono.Cecil.Cil;
using Mono.Cecil.Rocks;

if (args.Length == 2 && args[0] == "--refs")
{
    using var m = ModuleDefinition.ReadModule(args[1]);
    foreach (var r in m.AssemblyReferences) Console.WriteLine($"{r.FullName}{(r.IsWindowsRuntime ? "  [WindowsRuntime]" : "")}");
    return 0;
}
if (args.Length != 3) { Console.Error.WriteLine("usage: Patcher <Monarch.exe> <MonarchMouse.dll> <out.exe>"); return 2; }

string input = args[0], hooksDll = args[1], output = args[2];
var resolver = new DefaultAssemblyResolver();
resolver.AddSearchDirectory(Path.GetDirectoryName(Path.GetFullPath(input)));
using var module = ModuleDefinition.ReadModule(input, new ReaderParameters { AssemblyResolver = resolver });
using var hooksModule = ModuleDefinition.ReadModule(hooksDll);

if (module.AssemblyReferences.Any(r => r.Name == "MonarchMouse"))
{
    Console.Error.WriteLine("This Monarch.exe is already patched. Start from the unpatched one.");
    return 1;
}

var hooks = hooksModule.GetType("MonarchMouse.Hooks") ?? throw new Exception("MonarchMouse.Hooks not found");
MethodReference Hook(string name) => module.ImportReference(hooks.Methods.Single(m => m.Name == name));

TypeDefinition Type(string name) => module.GetType(name) ?? throw new Exception(name + " not found");
MethodDefinition Method(TypeDefinition t, string name, int parameters) =>
    t.Methods.Single(m => m.Name == name && m.Parameters.Count == parameters && !m.IsStatic);

var app = Type("Monarch.App");
var mouseDevice = Type("Monarch.MouseDevice");

// 1. MouseDevice.Start(): before every return, call Hooks.Started(this).
{
    var m = Method(mouseDevice, "Start", 0);
    Expect(m.ReturnType.FullName == "System.Void", "MouseDevice.Start returns void");
    var body = m.Body; body.SimplifyMacros();
    var il = body.GetILProcessor();
    foreach (var ret in body.Instructions.Where(i => i.OpCode == OpCodes.Ret).ToList())
    {
        // The ret instruction itself becomes the first of the inserted ones, so branches that
        // jumped to the return now run the hook first.
        ret.OpCode = OpCodes.Ldarg_0; ret.Operand = null;
        var call = il.Create(OpCodes.Call, Hook("Started"));
        il.InsertAfter(ret, call);
        il.InsertAfter(call, il.Create(OpCodes.Ret));
    }
    body.OptimizeMacros();
    Console.WriteLine("hooked MouseDevice.Start");
}

// 2. App.MouseState(): the dictionary it returns passes through Hooks.State(dict, this).
{
    var m = Method(app, "MouseState", 0);
    Expect(m.ReturnType.FullName == "System.Collections.Generic.Dictionary`2<System.String,System.Object>", "App.MouseState returns Dictionary<string, object>");
    var body = m.Body; body.SimplifyMacros();
    var il = body.GetILProcessor();
    foreach (var ret in body.Instructions.Where(i => i.OpCode == OpCodes.Ret).ToList())
    {
        ret.OpCode = OpCodes.Ldarg_0; ret.Operand = null;    // stack: dict, this
        var call = il.Create(OpCodes.Call, Hook("State"));   // stack: dict
        il.InsertAfter(ret, call);
        il.InsertAfter(call, il.Create(OpCodes.Ret));
    }
    body.OptimizeMacros();
    Console.WriteLine("hooked App.MouseState");
}

// 3. App.Call(string, object[]): ask Hooks.Call first.
{
    var m = Method(app, "Call", 2);
    Expect(m.Parameters[0].ParameterType.FullName == "System.String" && m.Parameters[1].ParameterType.FullName == "System.Object[]", "App.Call(string, object[])");
    Expect(m.ReturnType.FullName == "System.Threading.Tasks.Task`1<System.Object>", "App.Call returns Task<object>");
    var body = m.Body; body.SimplifyMacros();
    var il = body.GetILProcessor();
    var first = body.Instructions[0];
    var pop = il.Create(OpCodes.Pop);
    foreach (var i in new[]
    {
        il.Create(OpCodes.Ldarg_0),
        il.Create(OpCodes.Ldarg_1),
        il.Create(OpCodes.Ldarg_2),
        il.Create(OpCodes.Call, Hook("Call")),   // stack: task or null
        il.Create(OpCodes.Dup),
        il.Create(OpCodes.Brfalse, pop),
        il.Create(OpCodes.Ret),                  // handled: return that task
        pop,                                     // not handled: drop the null, carry on as before
    })
        il.InsertBefore(first, i);
    body.OptimizeMacros();
    Console.WriteLine("hooked App.Call");
}

module.Write(output);
Console.WriteLine("wrote " + output);
return 0;

static void Expect(bool ok, string what) { if (!ok) throw new Exception("Monarch.exe isn't the version this patch was written for: expected " + what); }
