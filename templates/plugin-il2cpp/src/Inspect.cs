using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.Json.Nodes;
using Il2CppInterop.Runtime;
using Il2CppInterop.Runtime.InteropTypes;
using UnityEngine;
using UObject = UnityEngine.Object;

namespace GameHelper;

/// <summary>
/// Команды агента для исследования живой игры (не для панели, в availability не попадают).
/// Регистрируются только при [Dev] DevTools=true. Всё — на главном потоке, кроме inspect.types и log.tail.
///
///   inspect.types  {query}                         управляемые interop-типы по подстроке имени
///   inspect.find   {type?, name?, limit?, assets?} объекты Unity в загруженных сценах (по типу компонента и/или имени)
///   inspect.get    {target, path?, depth?, methods?}  прочитать объект/член
///   inspect.set    {target, path, value}           записать поле/свойство (примитив, строка, enum, struct {x,y,z})
///   inspect.invoke {target, path?, method, args?}  вызвать метод (аргументы — примитивы/строки/enum/struct)
///   log.tail       {n?, grep?}                     хвост BepInEx/LogOutput.log
///
/// target: "obj:&lt;id&gt;" (id из find/get), "go:&lt;имя GameObject&gt;", "type:&lt;Тип&gt;" (статические члены).
/// path: члены через точку; "@Тип" — GetComponent; число — элемент списка/массива.
///   пример: {"target":"go:Player","path":"@Health.current"}
///
/// Как устроено: interop-обёртки (Il2CppInterop) отдают поля Il2Cpp как управляемые свойства с теми же
/// именами, поэтому работает обычная .NET-рефлексия по обёртке нужного (самого производного) типа.
/// Ограничения:
///  - обфусцированные/переименованные поля называются как в interop (field_Private_Int32_0 и т.п.);
///  - generic-методы, ref/out, делегаты и Il2Cpp-объекты в аргументах invoke не поддерживаются;
///  - чтение свойства вызывает его геттер (у игры бывают геттеры с побочными эффектами);
///  - struct, полученные через интерфейс, interop читает со сдвигом (известная грабля) — проверять значения;
///  - статические поля generic-классов недоступны.
/// [I] проверить на первой игре: Activator.CreateInstance(type, ptr), Scene.IsValid(), GetInstanceID в Unity 6.x.
/// </summary>
public static class Inspect
{
    const int MaxItems = 50;
    const int MaxMembers = 150;

    static readonly Dictionary<int, Il2CppObjectBase> Handles = new();
    static readonly object IndexLock = new();
    static Dictionary<string, Type> byFullName;
    static Dictionary<string, List<Type>> byShortName;

    static readonly HashSet<string> InteropNoise = new(StringComparer.Ordinal)
    {
        "Pointer", "ObjectClass", "WasCollected", "isWrapped", "pooledPtr",
    };

    public static void Register()
    {
        Api.Register("inspect.types", Types, info: Info("Найти interop-тип по имени", "{\"query\":\"string\"}"), offThread: true, dev: true);
        Api.Register("inspect.find", Find, info: Info("Найти объекты в сцене", "{\"type\":\"string?\",\"name\":\"string?\",\"limit\":\"number?\"}"), dev: true);
        Api.Register("inspect.get", Get, info: Info("Прочитать объект или поле", "{\"target\":\"string\",\"path\":\"string?\",\"depth\":\"number?\"}"), dev: true);
        Api.Register("inspect.set", Set, info: Info("Записать поле или свойство", "{\"target\":\"string\",\"path\":\"string\",\"value\":\"any\"}"), dev: true);
        Api.Register("inspect.invoke", InvokeMethod, info: Info("Вызвать метод объекта", "{\"target\":\"string\",\"path\":\"string?\",\"method\":\"string\",\"args\":\"array?\"}"), dev: true);
        Api.Register("log.tail", LogTail, info: Info("Хвост журнала BepInEx", "{\"n\":\"number?\",\"grep\":\"string?\"}"), offThread: true, dev: true);
        Plugin.Warn("DevTools on: inspect.* and log.tail are available on the local API");
    }

    static CommandInfo Info(string title, string args) => new(title) { Args = JsonNode.Parse(args) as JsonObject };

    // ================================================================== типы

    static void EnsureIndex()
    {
        lock (IndexLock)
        {
            if (byFullName != null) return;
            var full = new Dictionary<string, Type>(StringComparer.Ordinal);
            var shortNames = new Dictionary<string, List<Type>>(StringComparer.OrdinalIgnoreCase);
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                if (asm.IsDynamic) continue;
                Type[] types;
                try { types = asm.GetTypes(); }
                catch (ReflectionTypeLoadException e) { types = e.Types.Where(t => t != null).ToArray(); }
                catch { continue; }
                foreach (var t in types)
                {
                    if (t.FullName == null || !typeof(Il2CppObjectBase).IsAssignableFrom(t)) continue;
                    full[t.FullName] = t;
                    if (!shortNames.TryGetValue(t.Name, out var list)) shortNames[t.Name] = list = new List<Type>();
                    list.Add(t);
                }
            }
            byFullName = full;
            byShortName = shortNames;
        }
    }

    /// <summary>Имя Il2Cpp ("Ns.Outer/Inner") или управляемое → interop-тип. Префикс Il2Cpp у пространств имён учтён.</summary>
    static Type TryResolveType(string name)
    {
        if (string.IsNullOrEmpty(name)) return null;
        EnsureIndex();
        var n = name.Replace('/', '+');
        foreach (var candidate in new[] { n, "Il2Cpp" + n, "Il2Cpp." + n })
            if (byFullName.TryGetValue(candidate, out var t)) return t;
        if (byShortName.TryGetValue(n, out var list) && list.Count > 0)
            return list.FirstOrDefault(t => t.Assembly.GetName().Name == "Assembly-CSharp") ?? (list.Count == 1 ? list[0] : null);
        return null;
    }

    static Type ResolveType(string name)
    {
        var t = TryResolveType(name);
        if (t != null) return t;
        EnsureIndex();
        if (byShortName.TryGetValue(name, out var list) && list.Count > 1)
            throw new GameException($"Неоднозначный тип {name}: {string.Join(", ", list.Take(5).Select(x => x.FullName))}");
        throw new GameException("Тип не найден: " + name + " (inspect.types)");
    }

    static JsonObject Types(JsonObject args)
    {
        var query = args.Str("query") ?? throw new GameException("Нужен query");
        EnsureIndex();
        var found = byFullName.Values
            .Where(t => t.FullName.Contains(query, StringComparison.OrdinalIgnoreCase))
            .OrderBy(t => t.Name.Length).Take(100)
            .Select(t => (JsonNode)new JsonObject { ["type"] = t.FullName, ["assembly"] = t.Assembly.GetName().Name })
            .ToArray();
        return new JsonObject { ["types"] = new JsonArray(found) };
    }

    // ================================================================== поиск

    static JsonObject Find(JsonObject args)
    {
        var typeName = args.Str("type");
        var name = args.Str("name");
        var limit = (int)Math.Clamp(args.Num("limit", 30), 1, 200);
        var assets = args.Bool("assets");

        Il2CppSystem.Type il2cppType;
        if (!string.IsNullOrEmpty(typeName))
        {
            var managed = ResolveType(typeName);
            if (!typeof(UObject).IsAssignableFrom(managed))
                throw new GameException($"{managed.Name} не объект Unity — статику читать через inspect.get type:{managed.Name}");
            il2cppType = Il2CppType.From(managed);
        }
        else if (!string.IsNullOrEmpty(name)) il2cppType = Il2CppType.Of<GameObject>();
        else throw new GameException("Нужен type или name");

        var result = new JsonArray();
        var total = 0;
        foreach (var o in Resources.FindObjectsOfTypeAll(il2cppType))
        {
            if (o == null) continue;
            var go = GameObjectOf(o);
            if (go != null ? !InLoadedScene(go) : !assets) continue; // префабы/ассеты пропускаем
            string objName;
            try { objName = o.name ?? ""; } catch { objName = ""; }
            if (!string.IsNullOrEmpty(name) && objName.IndexOf(name, StringComparison.OrdinalIgnoreCase) < 0) continue;
            total++;
            if (result.Count >= limit) continue;
            var item = Ref(o);
            if (go != null)
            {
                item["path"] = PathOf(go);
                item["active"] = go.activeInHierarchy;
            }
            result.Add(item);
        }
        return new JsonObject { ["total"] = total, ["items"] = result };
    }

    static GameObject GameObjectOf(UObject o)
    {
        if (o == null) return null;
        var go = o.TryCast<GameObject>();
        if (go != null) return go;
        var c = o.TryCast<Component>();
        return c != null ? c.gameObject : null;
    }

    static bool InLoadedScene(GameObject go)
    {
        try { return go.scene.IsValid(); } // [I] проверить: у префабов-ассетов сцена невалидна
        catch { return false; }
    }

    static string PathOf(GameObject go)
    {
        var parts = new List<string>();
        var t = go.transform;
        for (var i = 0; t != null && i < 32; i++, t = t.parent) parts.Add(t.name);
        parts.Reverse();
        return string.Join("/", parts);
    }

    // ================================================================== цель и путь

    static (object obj, Type type) ResolveTarget(string target)
    {
        if (string.IsNullOrEmpty(target)) throw new GameException("Нужен target: obj:<id> | go:<имя> | type:<Тип>");
        var colon = target.IndexOf(':');
        var kind = colon > 0 ? target[..colon] : "";
        var value = colon > 0 ? target[(colon + 1)..] : target;
        switch (kind)
        {
            case "obj":
                if (!int.TryParse(value, out var id)) throw new GameException("obj:<id> — число из inspect.find");
                Il2CppObjectBase o;
                lock (Handles) Handles.TryGetValue(id, out o);
                if (o == null || o.WasCollected || (o is UObject u && u == null))
                    throw new GameException($"Объект {id} не найден или уничтожен — повтори inspect.find");
                var s = Specialize(o);
                return (s, s.GetType());
            case "go":
                GameObject best = null;
                foreach (var x in Resources.FindObjectsOfTypeAll(Il2CppType.Of<GameObject>()))
                {
                    var go = x?.TryCast<GameObject>();
                    if (go == null || go.name != value || !InLoadedScene(go)) continue;
                    best = go;
                    if (go.activeInHierarchy) break;
                }
                if (best == null) throw new GameException("GameObject не найден: " + value);
                return (best, typeof(GameObject));
            case "type":
                return (null, ResolveType(value));
            default:
                throw new GameException("target: obj:<id> | go:<имя> | type:<Тип>");
        }
    }

    static IEnumerable<string> Segments(string path) =>
        string.IsNullOrEmpty(path) ? Array.Empty<string>() : path.Split('.', StringSplitOptions.RemoveEmptyEntries);

    static (object obj, Type type) Walk(object obj, Type type, IEnumerable<string> segments)
    {
        foreach (var seg in segments)
        {
            obj = Step(obj, type, seg);
            if (obj == null) throw new GameException($"{seg} = null");
            type = obj.GetType();
        }
        return (obj, type);
    }

    static object Step(object obj, Type type, string seg)
    {
        if (seg.StartsWith("@"))
        {
            var go = obj is Il2CppObjectBase b ? GameObjectOf(b.TryCast<UObject>()) : null;
            if (go == null) throw new GameException("@Компонент — только у GameObject/Component");
            var comp = go.GetComponent(Il2CppType.From(ResolveType(seg[1..])));
            if (comp == null) throw new GameException($"На {go.name} нет компонента {seg[1..]}");
            return Specialize(comp);
        }
        if (int.TryParse(seg, out var index)) return Specialize(Index(obj, index));
        if (seg.EndsWith("()")) return Specialize(Call(obj, type, seg[..^2], new JsonArray()));

        var flags = Flags(obj);
        var prop = FindProperty(type, seg, flags);
        if (prop != null) return Specialize(prop.GetValue(obj));
        var field = type.GetField(seg, flags);
        if (field != null) return Specialize(field.GetValue(obj));
        throw new GameException($"У {type.Name} нет члена {seg}");
    }

    static BindingFlags Flags(object obj) =>
        (obj == null ? BindingFlags.Static : BindingFlags.Instance) | BindingFlags.Public | BindingFlags.NonPublic |
        BindingFlags.FlattenHierarchy | BindingFlags.IgnoreCase;

    static PropertyInfo FindProperty(Type type, string name, BindingFlags flags)
    {
        try { return type.GetProperty(name, flags); }
        catch (AmbiguousMatchException)
        {
            return type.GetProperties(flags).FirstOrDefault(p => p.Name == name && p.GetIndexParameters().Length == 0);
        }
    }

    static object Index(object obj, int index)
    {
        if (obj == null) throw new GameException("Индекс у null");
        if (obj is IList list) return list[index];
        var getItem = obj.GetType().GetMethod("get_Item", new[] { typeof(int) });
        if (getItem != null) return getItem.Invoke(obj, new object[] { index });
        if (obj is IEnumerable e) return e.Cast<object>().ElementAt(index);
        throw new GameException($"{obj.GetType().Name} не список");
    }

    /// <summary>Обёртка самого производного типа: иначе члены наследника не видны рефлексии.</summary>
    static object Specialize(object value)
    {
        if (value is not Il2CppObjectBase o) return value;
        try
        {
            var managed = TryResolveType(Il2CppName(o));
            if (managed != null && managed != o.GetType() && o.GetType().IsAssignableFrom(managed))
                return Activator.CreateInstance(managed, o.Pointer); // [I] проверить: ctor(IntPtr) у обёрток interop
        }
        catch (Exception e) { Plugin.Warn("inspect: specialize: " + e.Message); }
        return o;
    }

    static string Il2CppName(Il2CppObjectBase o)
    {
        try { return o.TryCast<Il2CppSystem.Object>()?.GetIl2CppType()?.FullName ?? o.GetType().FullName; }
        catch { return o.GetType().FullName; }
    }

    // ================================================================== get / set / invoke

    static JsonObject Get(JsonObject args)
    {
        var (root, rootType) = ResolveTarget(args.Str("target"));
        var depth = (int)Math.Clamp(args.Num("depth", 1), 0, 3);
        var path = Segments(args.Str("path")).ToArray();
        if (path.Length == 0 && root == null) return DescribeStatic(rootType, args.Bool("methods"));
        var (obj, type) = Walk(root, rootType, path);
        var result = new JsonObject { ["value"] = ToJson(obj, depth) };
        if (args.Bool("methods")) result["methods"] = Methods(type, BindingFlags.Instance);
        return result;
    }

    static JsonObject Set(JsonObject args)
    {
        var (root, rootType) = ResolveTarget(args.Str("target"));
        var path = Segments(args.Str("path")).ToArray();
        if (path.Length == 0) throw new GameException("Нужен path к полю");
        var (obj, type) = path.Length == 1 ? (root, rootType) : Walk(root, rootType, path[..^1]);
        var name = path[^1];
        var flags = Flags(obj);
        var prop = FindProperty(type, name, flags);
        if (prop != null && prop.CanWrite)
        {
            prop.SetValue(obj, Convert(args["value"], prop.PropertyType));
            return new JsonObject { ["value"] = ToJson(prop.GetValue(obj), 0) };
        }
        var field = type.GetField(name, flags);
        if (field != null && !field.IsInitOnly && !field.IsLiteral)
        {
            field.SetValue(obj, Convert(args["value"], field.FieldType));
            return new JsonObject { ["value"] = ToJson(field.GetValue(obj), 0) };
        }
        throw new GameException($"У {type.Name} нет записываемого члена {name}");
    }

    static JsonObject InvokeMethod(JsonObject args)
    {
        var (root, rootType) = ResolveTarget(args.Str("target"));
        var (obj, type) = Walk(root, rootType, Segments(args.Str("path")));
        var method = args.Str("method") ?? throw new GameException("Нужен method");
        var result = Call(obj, type, method, args["args"] as JsonArray ?? new JsonArray());
        return new JsonObject { ["value"] = ToJson(Specialize(result), 1) };
    }

    static object Call(object obj, Type type, string name, JsonArray args)
    {
        var candidates = type.GetMethods(Flags(obj))
            .Where(m => string.Equals(m.Name, name, StringComparison.OrdinalIgnoreCase) && !m.IsGenericMethodDefinition &&
                        m.GetParameters().Length == args.Count)
            .ToArray();
        if (candidates.Length == 0) throw new GameException($"У {type.Name} нет метода {name} с {args.Count} аргументами");
        Exception last = null;
        foreach (var m in candidates)
        {
            object[] values;
            try { values = m.GetParameters().Select((p, i) => Convert(args[i], p.ParameterType)).ToArray(); }
            catch (Exception e) { last = e; continue; }
            Plugin.Info($"inspect.invoke {type.Name}.{m.Name}");
            return m.Invoke(obj, values);
        }
        throw new GameException($"Аргументы не подходят к {type.Name}.{name}: {last?.Message}");
    }

    /// <summary>JSON → значение параметра/поля: строки, bool, числа, enum, struct из {поле: значение}.</summary>
    static object Convert(JsonNode node, Type t)
    {
        if (t.IsByRef || t.IsPointer) throw new GameException("ref/out/указатели не поддерживаются");
        var text = node is JsonValue v && v.TryGetValue<string>(out var s) ? s : node?.ToJsonString();
        if (t == typeof(string)) return node == null ? null : text;
        if (t == typeof(bool)) return Json.Bool(node);
        if (t.IsEnum) return Enum.Parse(t, text ?? "", true);
        if (t.IsPrimitive)
        {
            if (t == typeof(char)) return string.IsNullOrEmpty(text) ? '\0' : text[0];
            var d = decimal.Parse(text ?? "0", NumberStyles.Float, CultureInfo.InvariantCulture);
            return System.Convert.ChangeType(d, t, CultureInfo.InvariantCulture);
        }
        if (t.IsValueType && node is JsonObject o)
        {
            var boxed = Activator.CreateInstance(t);
            foreach (var (key, value) in o)
            {
                var f = t.GetField(key, BindingFlags.Instance | BindingFlags.Public | BindingFlags.IgnoreCase);
                if (f == null) throw new GameException($"У {t.Name} нет поля {key}");
                f.SetValue(boxed, Convert(value, f.FieldType));
            }
            return boxed;
        }
        throw new GameException($"Тип {t.Name} не поддерживается для записи/вызова");
    }

    // ================================================================== JSON

    static JsonObject Ref(Il2CppObjectBase o)
    {
        var r = new JsonObject { ["$type"] = Il2CppName(o) };
        var u = o.TryCast<UObject>();
        if (u != null)
        {
            try
            {
                var id = u.GetInstanceID(); // [I] Unity 6.x: может быть [Obsolete] в пользу EntityId
                lock (Handles)
                {
                    if (Handles.Count > 5000) Handles.Clear(); // старые id станут «повтори inspect.find»
                    Handles[id] = u;
                }
                r["id"] = id;
                r["name"] = u.name;
            }
            catch { /* уничтожен */ }
        }
        return r;
    }

    static JsonNode ToJson(object v, int depth)
    {
        switch (v)
        {
            case null: return null;
            case string s: return s;
            case bool b: return b;
            case char c: return c.ToString();
            case Enum e: return e.ToString();
            case float f: return float.IsFinite(f) ? JsonValue.Create(Math.Round(f, 5)) : f.ToString(CultureInfo.InvariantCulture);
            case double d: return double.IsFinite(d) ? JsonValue.Create(d) : d.ToString(CultureInfo.InvariantCulture);
            case IntPtr p: return "0x" + p.ToString("X");
            case decimal m: return JsonValue.Create(m);
            case Il2CppObjectBase o: return depth <= 0 ? Ref(o) : Describe(o, depth);
        }
        var t = v.GetType();
        if (t.IsPrimitive) return JsonValue.Create(System.Convert.ToInt64(v, CultureInfo.InvariantCulture));
        if (v is IEnumerable en)
        {
            var arr = new JsonArray();
            foreach (var item in en)
            {
                if (arr.Count >= MaxItems) { arr.Add("…"); break; }
                arr.Add(ToJson(Specialize(item), depth - 1));
            }
            return arr;
        }
        try { return v.ToString(); } // Vector3, Color и др. struct
        catch (Exception e) { return "!" + e.Message; }
    }

    static JsonObject Describe(Il2CppObjectBase o, int depth)
    {
        var result = Ref(o);
        var type = o.GetType();

        // Il2Cpp-коллекции (List<T>, Dictionary...) — не IEnumerable в управляемом смысле.
        var count = type.GetProperty("Count", BindingFlags.Instance | BindingFlags.Public);
        var getItem = type.GetMethod("get_Item", new[] { typeof(int) });
        if (count != null && getItem != null)
        {
            try
            {
                var n = System.Convert.ToInt32(count.GetValue(o));
                result["count"] = n;
                var items = new JsonArray();
                for (var i = 0; i < Math.Min(n, MaxItems); i++)
                    items.Add(ToJson(Specialize(getItem.Invoke(o, new object[] { i })), depth - 1));
                result["items"] = items;
            }
            catch (Exception e) { result["items"] = "!" + Unwrap(e).Message; }
        }
        else if (o is IEnumerable en) // Il2CppArrayBase<T> и т.п.
        {
            var items = new JsonArray();
            try
            {
                foreach (var item in en)
                {
                    if (items.Count >= MaxItems) { items.Add("…"); break; }
                    items.Add(ToJson(Specialize(item), depth - 1));
                }
            }
            catch (Exception e) { items.Add("!" + Unwrap(e).Message); }
            result["items"] = items;
        }

        var go = o.TryCast<GameObject>();
        if (go != null)
        {
            result["path"] = PathOf(go);
            result["active"] = go.activeInHierarchy;
            var comps = new JsonArray();
            foreach (var c in go.GetComponents(Il2CppType.Of<Component>()))
                if (c != null) comps.Add(Ref(c));
            result["components"] = comps;
            var children = new JsonArray();
            var tr = go.transform;
            for (var i = 0; i < Math.Min(tr.childCount, MaxItems); i++) children.Add(tr.GetChild(i).name);
            result["children"] = children;
            return result;
        }

        result["members"] = Members(o, type, depth);
        return result;
    }

    /// <summary>Свойства/поля обёртки: от самого производного типа вниз до первого базового типа Unity/Il2CppSystem.</summary>
    static JsonObject Members(object o, Type type, int depth)
    {
        var members = new JsonObject();
        var first = true;
        for (var t = type; t != null && t != typeof(Il2CppObjectBase); t = t.BaseType)
        {
            var ns = t.Namespace ?? "";
            if (!first && (ns.StartsWith("UnityEngine") || ns.StartsWith("Il2CppSystem"))) break;
            first = false;
            const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly;
            foreach (var p in t.GetProperties(flags))
            {
                if (members.Count >= MaxMembers) return members;
                if (InteropNoise.Contains(p.Name) || p.GetIndexParameters().Length > 0 || p.GetMethod == null || members.ContainsKey(p.Name)) continue;
                members[p.Name] = Read(() => p.GetValue(o), depth);
            }
            foreach (var f in t.GetFields(flags))
            {
                if (members.Count >= MaxMembers) return members;
                if (f.Name.StartsWith("NativeFieldInfoPtr_") || f.Name.StartsWith("NativeMethodInfoPtr_") || members.ContainsKey(f.Name)) continue;
                members[f.Name] = Read(() => f.GetValue(o), depth);
            }
        }
        return members;
    }

    static JsonNode Read(Func<object> getter, int depth)
    {
        try { return ToJson(Specialize(getter()), depth - 1); }
        catch (Exception e) { return "!" + Unwrap(e).Message; }
    }

    static JsonObject DescribeStatic(Type type, bool methods)
    {
        var members = new JsonObject();
        const BindingFlags flags = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly;
        foreach (var p in type.GetProperties(flags))
        {
            if (members.Count >= MaxMembers) break;
            if (p.GetIndexParameters().Length > 0 || p.GetMethod == null) continue;
            members[p.Name] = Read(() => p.GetValue(null), 1);
        }
        var result = new JsonObject { ["$type"] = type.FullName, ["static"] = members };
        if (methods) result["methods"] = Methods(type, BindingFlags.Static);
        return result;
    }

    static JsonArray Methods(Type type, BindingFlags kind)
    {
        var list = type.GetMethods(kind | BindingFlags.Public | BindingFlags.DeclaredOnly)
            .Where(m => !m.IsSpecialName)
            .Select(m => $"{m.ReturnType.Name} {m.Name}({string.Join(", ", m.GetParameters().Select(p => p.ParameterType.Name + " " + p.Name))})")
            .Distinct().Take(200)
            .Select(s => (JsonNode)s).ToArray();
        return new JsonArray(list);
    }

    static Exception Unwrap(Exception e) => e is TargetInvocationException t && t.InnerException != null ? t.InnerException : e;

    // ================================================================== журнал

    static JsonObject LogTail(JsonObject args)
    {
        var n = (int)Math.Clamp(args.Num("n", 100), 1, 1000);
        var grep = args.Str("grep");
        var path = Path.Combine(BepInEx.Paths.BepInExRootPath, "LogOutput.log");
        if (!File.Exists(path)) throw new GameException("Нет файла журнала: " + path);
        string text;
        using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        {
            fs.Seek(Math.Max(0, fs.Length - 1_000_000), SeekOrigin.Begin);
            using var reader = new StreamReader(fs, Encoding.UTF8);
            text = reader.ReadToEnd();
        }
        var lines = text.Split('\n').Select(l => l.TrimEnd('\r'));
        if (!string.IsNullOrEmpty(grep)) lines = lines.Where(l => l.Contains(grep, StringComparison.OrdinalIgnoreCase));
        var tail = lines.Where(l => l.Length > 0).TakeLast(n).Select(l => (JsonNode)l).ToArray();
        return new JsonObject { ["path"] = path, ["lines"] = new JsonArray(tail) };
    }
}
