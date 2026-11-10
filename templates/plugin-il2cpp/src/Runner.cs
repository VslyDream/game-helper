using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading;
using UnityEngine;

namespace GameHelper;

/// <summary>Пауза внутри итератора <see cref="Runner.Start"/>: секунды unscaled-времени (работает и на паузе игры).</summary>
public sealed class Wait
{
    public readonly float Seconds;
    public Wait(float seconds) => Seconds = seconds;
}

/// <summary>
/// Насос главного потока. Unity API вызывается ТОЛЬКО отсюда: HTTP-потоки кладут работу в очередь
/// (<see cref="Post"/>) или ждут результат (<see cref="Invoke{T}"/>). Долгие операции — управляемые
/// итераторы (<see cref="Start"/>), один шаг за кадр:
///   yield return null;              следующий кадр
///   yield return new Wait(0.5f);    пауза (unscaled)
///   yield return (Func&lt;bool&gt;)(() => ready);  ждать условия
/// IL2CPP-корутины (StartCoroutine) через interop капризны, поэтому не используются.
/// </summary>
public class Runner : MonoBehaviour
{
    public Runner(IntPtr ptr) : base(ptr) { }

    static readonly ConcurrentQueue<Action> Queue = new();
    static readonly List<Routine> Routines = new();
    static int mainThreadId = -1;
    static bool started;
    static float nextBackgroundCheck;

    /// <summary>Каждый кадр после очереди (State.Tick, хоткеи, слежение за уровнем). Только главный поток.</summary>
    public static event Action OnFrame;

    /// <summary>Однажды, на первом кадре: здесь Unity уже готов (повторное применение читов, CORE-17).</summary>
    public static event Action OnFirstFrame;

    public static bool IsMainThread => Thread.CurrentThread.ManagedThreadId == mainThreadId;

    sealed class Routine
    {
        public IEnumerator Body;
        public float ResumeAt;
        public Func<bool> Until;
        public Action<Exception> OnError;
    }

    public static void Post(Action action) => Queue.Enqueue(action);

    /// <summary>Выполнить на главном потоке и дождаться результата (из HTTP-потоков).</summary>
    public static T Invoke<T>(Func<T> func, int timeoutMs = 10000)
    {
        if (IsMainThread) return func(); // иначе дедлок: главный поток ждал бы сам себя
        using var done = new ManualResetEventSlim();
        T result = default;
        Exception error = null;
        Post(() =>
        {
            try { result = func(); }
            catch (Exception e) { error = e; }
            finally
            {
                try { done.Set(); } catch (ObjectDisposedException) { /* вызывающий уже ушёл по таймауту */ }
            }
        });
        if (!done.Wait(timeoutMs))
            throw new TimeoutException(mainThreadId < 0
                ? "Игра ещё не начала отрисовку кадров (загрузка)"
                : "Игра не ответила вовремя (идёт загрузка?)");
        if (error != null)
        {
            error = Unwrap(error);
            if (error is GameException) throw new GameException(error.Message, error);
            Plugin.Error(error.ToString());
            throw new GameException("Ошибка мода: " + error.Message, error);
        }
        return result;
    }

    public static void Invoke(Action action, int timeoutMs = 10000) => Invoke(() => { action(); return true; }, timeoutMs);

    /// <summary>Запустить долгую операцию (итератор) на главном потоке.</summary>
    public static void Start(IEnumerator body, Action<Exception> onError = null) =>
        Post(() => Routines.Add(new Routine { Body = body, OnError = onError }));

    static Exception Unwrap(Exception e) =>
        e is System.Reflection.TargetInvocationException t && t.InnerException != null ? t.InnerException : e;

    public void Update()
    {
        if (!started)
        {
            started = true;
            mainThreadId = Thread.CurrentThread.ManagedThreadId;
            // CORE-19: без этого игра встаёт, пока фокус в браузере, и панель «не работает».
            Application.runInBackground = true;
            Plugin.Info("runner: first frame, runInBackground=true");
            Safe(OnFirstFrame, "first frame");
        }

        // Некоторые игры сбрасывают флаг при смене сцены/настроек графики — возвращаем.
        var now = Time.unscaledTime;
        if (now >= nextBackgroundCheck)
        {
            nextBackgroundCheck = now + 1f;
            if (!Application.runInBackground)
            {
                Application.runInBackground = true;
                Plugin.Info("runInBackground was reset by the game; set back to true");
            }
        }

        // Ограничение на кадр: лавина запросов не должна подвешивать игру.
        var budget = 256;
        while (budget-- > 0 && Queue.TryDequeue(out var action))
        {
            try { action(); }
            catch (Exception e) { Plugin.Error("main-thread action: " + e); }
        }

        Safe(OnFrame, "frame");
        StepRoutines(now);
    }

    static void StepRoutines(float now)
    {
        for (int i = Routines.Count - 1; i >= 0; i--)
        {
            if (i >= Routines.Count) continue; // итератор мог добавить/удалить
            var r = Routines[i];
            if (r.ResumeAt > now) continue;
            if (r.Until != null)
            {
                bool ready;
                try { ready = r.Until(); }
                catch (Exception e) { Fail(r, e); continue; }
                if (!ready) continue;
                r.Until = null;
            }
            try
            {
                if (!r.Body.MoveNext()) { Routines.Remove(r); continue; }
                switch (r.Body.Current)
                {
                    case Wait w: r.ResumeAt = now + w.Seconds; break;
                    case Func<bool> f: r.Until = f; break;
                }
            }
            catch (Exception e) { Fail(r, e); }
        }
    }

    static void Fail(Routine r, Exception e)
    {
        Routines.Remove(r);
        e = Unwrap(e);
        if (e is not GameException) Plugin.Error("routine: " + e);
        try { r.OnError?.Invoke(e); } catch { /* ignore */ }
    }

    static void Safe(Action handler, string what)
    {
        if (handler == null) return;
        foreach (Action h in handler.GetInvocationList())
        {
            try { h(); }
            catch (Exception e) { Plugin.Error($"{what}: {e}"); }
        }
    }
}

/// <summary>Ошибка, текст которой показывается пользователю как есть (короткая понятная причина).</summary>
public class GameException : Exception
{
    public GameException(string message, Exception inner = null) : base(message, inner) { }
}
