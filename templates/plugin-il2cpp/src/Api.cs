using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace GameHelper;

/// <summary>Описание команды для GET /api/commands (MCP-02, MCP-06): обычные слова и синонимы.</summary>
public sealed class CommandInfo
{
    public string Title;
    public string[] Aliases;
    /// <summary>Аргументы: имя → тип/описание, например {"value":"boolean"}.</summary>
    public JsonObject Args;

    public CommandInfo(string title, params string[] aliases)
    {
        Title = title;
        Aliases = aliases;
    }
}

/// <summary>
/// Локальный HTTP API плагина (контракт contracts/adapter.md):
///   GET  /api/state                 состояние (connection, operation, availability, модули)
///   POST /api/action                {id, command, args} → {ok:true, state, result?} | {ok:false, error}
///   GET  /api/commands              список команд для MCP (строится из реестра, без перезапуска MCP)
///   GET  /api/screenshot?w=&amp;fmt=&amp;frames=   кадр игры PNG/JPG
/// Только 127.0.0.1. Запросы с чужим Origin отклоняются; изменяющие — только с JSON-телом
/// (простая HTML-форма чужого сайта не может прислать application/json без preflight).
/// </summary>
public static class Api
{
    public delegate JsonObject Handler(JsonObject args);

    sealed class Entry
    {
        public string Command;
        public Handler Run;
        public Func<string> Unavailable; // null → доступна; иначе короткая причина или null
        public CommandInfo Info;
        public bool OffThread;           // обработчик сам управляет потоками (долгие операции)
        public bool Dev;                 // команда агента: не попадает в availability панели
    }

    static readonly Dictionary<string, Entry> Entries = new();
    static HttpListener listener;
    static int port;

    // Идемпотентность по id: повтор того же запроса получает первый ответ, мир не меняется дважды.
    const int AnswerCacheSize = 64;
    static readonly Dictionary<string, Task<string>> Answers = new();
    static readonly Queue<string> AnswerOrder = new();

    // ------------------------------------------------------------------ реестр

    /// <summary>
    /// Зарегистрировать команду. handler выполняется на главном потоке (через Runner.Invoke), если
    /// offThread=false. unavailable возвращает причину недоступности (показывается в панели) или null.
    /// </summary>
    public static void Register(string command, Handler handler, Func<string> unavailable = null,
        CommandInfo info = null, bool offThread = false, bool dev = false)
    {
        lock (Entries)
            Entries[command] = new Entry
            {
                Command = command, Run = handler, Unavailable = unavailable, Info = info,
                OffThread = offThread, Dev = dev,
            };
    }

    public static bool IsRegistered(string command)
    {
        lock (Entries) return Entries.ContainsKey(command);
    }

    /// <summary>Карта availability для state (главный поток).</summary>
    public static JsonObject Availability()
    {
        Entry[] list;
        lock (Entries) list = Entries.Values.ToArray();
        var map = new JsonObject();
        foreach (var e in list)
        {
            if (e.Dev) continue;
            string reason;
            try { reason = e.Unavailable?.Invoke(); }
            catch (Exception ex) { reason = ex.Message; }
            map[e.Command] = Available(reason);
        }
        return map;
    }

    public static JsonObject Available(string reason) => reason == null
        ? new JsonObject { ["enabled"] = true }
        : new JsonObject { ["enabled"] = false, ["reason"] = reason };

    /// <summary>Выполнить команду из кода, который уже на главном потоке (хоткей, итератор).</summary>
    public static JsonObject RunHere(string command, JsonObject args = null)
    {
        Entry e;
        lock (Entries)
            if (!Entries.TryGetValue(command, out e)) throw new GameException("Команда не поддерживается: " + command);
        var reason = e.Unavailable?.Invoke();
        if (reason != null) throw new GameException(reason);
        return e.Run(args ?? new JsonObject());
    }

    static JsonObject Run(string command, JsonObject args)
    {
        Entry e;
        lock (Entries)
            if (!Entries.TryGetValue(command, out e)) throw new GameException("Команда не поддерживается: " + command);
        if (e.OffThread)
        {
            // Доступность проверяем на главном потоке (Unity API), сам обработчик — здесь.
            var reason = Runner.Invoke(() => e.Unavailable?.Invoke());
            if (reason != null) throw new GameException(reason);
            return e.Run(args);
        }
        return Runner.Invoke(() =>
        {
            var reason = e.Unavailable?.Invoke();
            if (reason != null) throw new GameException(reason);
            return e.Run(args);
        });
    }

    /// <summary>GET /api/commands: команды реестра + по записи на каждый чит (MCP-02).</summary>
    static JsonArray CommandList()
    {
        Entry[] list;
        lock (Entries) list = Entries.Values.OrderBy(x => x.Command, StringComparer.Ordinal).ToArray();
        var result = new JsonArray();
        foreach (var e in list)
        {
            if (e.Command is "cheat.set" or "cheat.run") continue; // перечислены ниже по читам
            var item = new JsonObject { ["command"] = e.Command, ["title"] = e.Info?.Title ?? e.Command };
            if (e.Info?.Aliases is { Length: > 0 } aliases) item["aliases"] = new JsonArray(aliases.Select(a => (JsonNode)a).ToArray());
            item["args"] = e.Info?.Args != null ? JsonNode.Parse(e.Info.Args.ToJsonString()) : new JsonObject();
            if (e.Dev) item["dev"] = true;
            result.Add(item);
        }
        foreach (var item in Cheats.CommandList()) result.Add(item);
        return result;
    }

    // ------------------------------------------------------------------ сервер

    public static void Start(int listenPort)
    {
        port = listenPort;
        foreach (var host in new[] { "127.0.0.1", "localhost" })
        {
            try
            {
                listener = new HttpListener();
                listener.Prefixes.Add($"http://{host}:{port}/");
                listener.Start();
                break;
            }
            catch (Exception e)
            {
                Plugin.Warn($"API http://{host}:{port}/ failed: {e.Message}");
                try { listener?.Close(); } catch { /* ignore */ }
                listener = null;
            }
        }
        if (listener == null)
        {
            Plugin.Error($"API port {port} is busy or not allowed — панель не подключится. Сменить порт: [Api] Port в конфиге.");
            return;
        }
        new Thread(Loop) { IsBackground = true, Name = Plugin.Name + ".Api" }.Start();
    }

    public static void Stop()
    {
        try { listener?.Stop(); listener?.Close(); } catch { /* ignore */ }
        listener = null;
    }

    static void Loop()
    {
        while (listener is { IsListening: true })
        {
            HttpListenerContext ctx;
            try { ctx = listener.GetContext(); }
            catch { break; }
            // Не лямбда: с некоторыми interop-наборами компилятор падает на CS0656 (NullableAttribute).
            ThreadPool.QueueUserWorkItem(HandleItem, ctx);
        }
    }

    static void HandleItem(object item) => Handle((HttpListenerContext)item);

    static bool OriginAllowed(string origin)
    {
        if (string.IsNullOrEmpty(origin)) return true; // CLI/MCP/сервис без браузера
        var allowed = Plugin.AllowedOrigins.Value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return allowed.Any(a => string.Equals(a.TrimEnd('/'), origin.TrimEnd('/'), StringComparison.OrdinalIgnoreCase));
    }

    static bool HostAllowed(string host) =>
        // Защита от DNS rebinding: чужое имя, указывающее на 127.0.0.1, не пройдёт.
        string.IsNullOrEmpty(host) || host == $"127.0.0.1:{port}" || host == $"localhost:{port}";

    static void Handle(HttpListenerContext ctx)
    {
        var req = ctx.Request;
        try
        {
            if (!HostAllowed(req.Headers["Host"]) || !OriginAllowed(req.Headers["Origin"]))
            {
                Write(ctx, 403, Error("Запрос с чужого сайта отклонён."));
                return;
            }
            var path = req.Url!.AbsolutePath.TrimEnd('/');
            switch (req.HttpMethod, path)
            {
                case ("GET", "/api/state"):
                    Write(ctx, 200, StateJson());
                    break;
                case ("GET", "/api/commands"):
                    Write(ctx, 200, CommandList().ToJsonString());
                    break;
                case ("GET", "/api/screenshot"):
                    int.TryParse(req.QueryString["w"], out var maxWidth);
                    int.TryParse(req.QueryString["frames"], out var frames);
                    var jpg = string.Equals(req.QueryString["fmt"], "jpg", StringComparison.OrdinalIgnoreCase);
                    var bytes = Screenshot.Capture(maxWidth, jpg, frames <= 0 ? 1 : frames);
                    WriteBytes(ctx, 200, jpg ? "image/jpeg" : "image/png", bytes);
                    break;
                case ("POST", "/api/action"):
                    if (req.ContentType == null || !req.ContentType.StartsWith("application/json", StringComparison.OrdinalIgnoreCase))
                    {
                        Write(ctx, 415, Error("Нужен Content-Type: application/json"));
                        break;
                    }
                    string body;
                    using (var reader = new StreamReader(req.InputStream, Encoding.UTF8)) body = reader.ReadToEnd();
                    Write(ctx, 200, Action(body));
                    break;
                case ("OPTIONS", _):
                    // CORS не открываем: панель ходит через свой сервис или с разрешённого Origin.
                    WriteBytes(ctx, 204, "text/plain", Array.Empty<byte>());
                    break;
                default:
                    Write(ctx, 404, Error("Нет такого адреса"));
                    break;
            }
        }
        catch (Exception e)
        {
            if (e is not GameException and not TimeoutException) Plugin.Error("api: " + e);
            try { Write(ctx, e is GameException or TimeoutException ? 503 : 500, Error(Message(e))); } catch { /* клиент ушёл */ }
        }
    }

    /// <summary>Состояние; если главный поток занят (загрузка уровня) — короткий ответ вместо ошибки.</summary>
    static string StateJson()
    {
        try { return Runner.Invoke(State.Build, 5000).ToJsonString(); }
        catch (TimeoutException e)
        {
            return new JsonObject
            {
                ["connection"] = "waiting",
                ["gameRunning"] = true,
                ["operation"] = State.OperationCopy(),
                ["availability"] = new JsonObject(),
                ["note"] = e.Message,
            }.ToJsonString();
        }
    }

    static string Action(string body)
    {
        JsonObject request;
        try { request = JsonNode.Parse(body) as JsonObject; }
        catch (Exception) { request = null; }
        if (request == null) return Error("Запрос не JSON-объект");
        var id = request.Str("id");
        var command = request.Str("command");
        if (string.IsNullOrEmpty(command)) return Error("Не указана команда");
        var args = request["args"] as JsonObject ?? new JsonObject();

        if (id == null) return Execute(command, args);

        Task<string> task;
        TaskCompletionSource<string> mine = null;
        lock (Answers)
        {
            if (!Answers.TryGetValue(id, out task))
            {
                mine = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
                task = mine.Task;
                Answers[id] = task;
                AnswerOrder.Enqueue(id);
                while (AnswerOrder.Count > AnswerCacheSize) Answers.Remove(AnswerOrder.Dequeue());
            }
        }
        if (mine == null)
        {
            // Повтор: ждём ответ первого запроса (он мог ещё выполняться) и отдаём его же.
            return task.Wait(120000) ? task.Result : Error("Предыдущий запрос с этим id ещё выполняется");
        }
        string answer;
        try { answer = Execute(command, args); }
        catch (Exception e) { answer = Error(Message(e)); }
        mine.SetResult(answer);
        return answer;
    }

    static string Execute(string command, JsonObject args)
    {
        try
        {
            var result = Run(command, args);
            var answer = new JsonObject { ["ok"] = true };
            if (result != null) answer["result"] = result;
            answer["state"] = Runner.Invoke(State.Build, 5000);
            return answer.ToJsonString();
        }
        catch (Exception e)
        {
            if (e is not GameException and not TimeoutException) Plugin.Error($"{command}: {e}");
            return Error(Message(e));
        }
    }

    static string Message(Exception e) =>
        e is GameException or TimeoutException ? e.Message : "Ошибка мода: " + e.Message;

    public static string Error(string message) =>
        new JsonObject { ["ok"] = false, ["error"] = message }.ToJsonString();

    static void Write(HttpListenerContext ctx, int code, string json) =>
        WriteBytes(ctx, code, "application/json; charset=utf-8", Encoding.UTF8.GetBytes(json));

    static void WriteBytes(HttpListenerContext ctx, int code, string type, byte[] bytes)
    {
        ctx.Response.StatusCode = code;
        ctx.Response.ContentType = type;
        ctx.Response.Headers["Cache-Control"] = "no-store";
        ctx.Response.ContentLength64 = bytes.Length;
        ctx.Response.OutputStream.Write(bytes, 0, bytes.Length);
        ctx.Response.Close();
    }
}

/// <summary>Чтение аргументов команд без исключений на неверный тип.</summary>
public static class Json
{
    public static string Str(this JsonObject o, string key, string fallback = null)
    {
        if (o?[key] is not JsonValue v) return fallback;
        if (v.TryGetValue<string>(out var s)) return s;
        return v.ToJsonString();
    }

    public static double Num(this JsonObject o, string key, double fallback = 0)
    {
        if (o?[key] is not JsonValue v) return fallback;
        if (v.TryGetValue<double>(out var d)) return d;
        if (v.TryGetValue<long>(out var l)) return l;
        if (v.TryGetValue<int>(out var i)) return i;
        if (v.TryGetValue<float>(out var f)) return f;
        if (v.TryGetValue<string>(out var s) && double.TryParse(s, System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture, out d)) return d;
        if (v.TryGetValue<bool>(out var b)) return b ? 1 : 0;
        return fallback;
    }

    public static bool Bool(this JsonObject o, string key, bool fallback = false) => Bool(o?[key], fallback);

    public static bool Bool(JsonNode node, bool fallback = false)
    {
        if (node is not JsonValue v) return fallback;
        if (v.TryGetValue<bool>(out var b)) return b;
        if (v.TryGetValue<double>(out var d)) return d != 0;
        if (v.TryGetValue<long>(out var l)) return l != 0;
        if (v.TryGetValue<string>(out var s)) return s is "true" or "1" or "on";
        return fallback;
    }

    public static double Num(JsonNode node, double fallback = 0) =>
        node == null ? fallback : Num(new JsonObject { ["v"] = node.Copy() }, "v", fallback);

    /// <summary>Копия узла для вставки в другое дерево (у JsonNode один родитель).</summary>
    public static JsonNode Copy(this JsonNode node) => node == null ? null : JsonNode.Parse(node.ToJsonString());
}
