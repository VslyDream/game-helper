// InteropFix — пересохранение interop-сборок BepInEx 6 IL2CPP через Mono.Cecil.
//
// Когда нужно: Il2CppInterop некоторых BE-сборок (замечено на 6.0.0-be.791 + Unity 6000.x) пишет
// interop-сборки, метаданные которых CoreCLR отвергает из-за сгенерированных компилятором вложенных
// типов ("<>O", "<>c"):
//   BadImageFormatException: Duplicate type with name '<>O' in assembly 'UnityEngine.CoreModule'
// Чтение и запись сборки Mono.Cecil нормализует таблицы метаданных — ошибка уходит.
//
// Использование:
//   InteropFix <BepInEx\interop>            пересохранить (оригинал один раз → *.dll.orig), записать маркер
//   InteropFix <BepInEx\interop> --force    игнорировать маркер
//   InteropFix <BepInEx\interop> --restore  вернуть *.dll.orig и удалить маркер
// Маркер interop.fixed хранит имя|время каждой DLL: если BepInEx ничего не перегенерировал
// (игра не обновлялась), повторный запуск ничего не делает — его можно звать перед каждым запуском игры.
// Игра при этом должна быть закрыта (DLL заняты).
using Mono.Cecil;

if (args.Length < 1 || !Directory.Exists(args[0]))
{
    Console.Error.WriteLine("usage: InteropFix <BepInEx\\interop dir> [--force|--restore]");
    return 2;
}

var dir = args[0];
var force = args.Contains("--force");
var restore = args.Contains("--restore");
var marker = Path.Combine(dir, "interop.fixed");

if (restore)
{
    foreach (var orig in Directory.GetFiles(dir, "*.dll.orig"))
    {
        File.Copy(orig, orig[..^".orig".Length], overwrite: true);
        File.Delete(orig);
        Console.WriteLine("restored " + Path.GetFileName(orig[..^".orig".Length]));
    }
    if (File.Exists(marker)) File.Delete(marker);
    return 0;
}

var dlls = Directory.GetFiles(dir, "*.dll").OrderBy(p => p, StringComparer.OrdinalIgnoreCase).ToList();
string Stamp(string p) => Path.GetFileName(p) + "|" + File.GetLastWriteTimeUtc(p).Ticks;

if (!force && File.Exists(marker) && File.ReadAllLines(marker).SequenceEqual(dlls.Select(Stamp)))
{
    Console.WriteLine("interop already fixed");
    return 0;
}

var failed = 0;
foreach (var path in dlls)
{
    try
    {
        var bytes = File.ReadAllBytes(path);
        var output = new MemoryStream();
        // Резолвер открывает зависимости — держим его в своей области, чтобы ни один дескриптор не пережил запись.
        using (var resolver = new DefaultAssemblyResolver())
        {
            resolver.AddSearchDirectory(dir);
            using var asm = AssemblyDefinition.ReadAssembly(new MemoryStream(bytes), new ReaderParameters { AssemblyResolver = resolver });
            asm.Write(output);
        }
        if (!File.Exists(path + ".orig"))
            File.WriteAllBytes(path + ".orig", bytes);
        File.WriteAllBytes(path, output.ToArray());
        Console.WriteLine("rewrote " + Path.GetFileName(path));
    }
    catch (Exception e)
    {
        failed++;
        Console.Error.WriteLine($"FAILED {Path.GetFileName(path)}: {e.Message}");
    }
}

if (failed > 0)
{
    Console.Error.WriteLine($"{failed} assemblies failed; marker not written (is the game running?)");
    return 1;
}
// Время перезаписанных файлов изменилось — маркер пишем по новым отметкам.
File.WriteAllLines(marker, dlls.Select(Stamp));
return 0;
