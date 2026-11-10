using System;
using System.Collections;
using System.Threading;
using UnityEngine;

namespace GameHelper;

/// <summary>
/// Кадр игры для MCP/CLI/снимков (MCP-03). ScreenCapture.CaptureScreenshotAsTexture + EncodeToPNG/JPG.
///
/// ScreenCapture.CaptureScreenshot(string path) через interop Unity 6 не работает (маршалинг ReadOnlySpan),
/// поэтому только перегрузка с текстурой и своё кодирование.
/// Захват идёт из Update через итератор Runner: кадр, отрисованный последним (frames — сколько кадров
/// подождать, чтобы результат только что выполненной команды успел попасть в картинку).
/// [I] проверить на игре: если кадр чёрный/без UI — ждать больше кадров или снимать камеру в RenderTexture.
/// </summary>
public static class Screenshot
{
    /// <summary>Из HTTP-потока: ждёт кадр. maxWidth &gt; 0 — уменьшить (агенту обычно хватает 960–1280).</summary>
    public static byte[] Capture(int maxWidth = 0, bool jpg = false, int frames = 1, int timeoutMs = 15000)
    {
        if (Runner.IsMainThread) return CaptureNow(maxWidth, jpg);
        byte[] result = null;
        Exception error = null;
        using var done = new ManualResetEventSlim();
        Runner.Start(Routine(frames, maxWidth, jpg, png => { result = png; Signal(done); }),
            e => { error = e; Signal(done); });
        if (!done.Wait(timeoutMs)) throw new TimeoutException("Игра не отдала кадр вовремя (загрузка?)");
        if (error != null) throw error as GameException ?? new GameException("Кадр не снят: " + error.Message, error);
        return result;
    }

    static void Signal(ManualResetEventSlim e)
    {
        try { e.Set(); } catch (ObjectDisposedException) { /* вызывающий ушёл по таймауту */ }
    }

    static IEnumerator Routine(int frames, int maxWidth, bool jpg, Action<byte[]> done)
    {
        for (var i = 0; i < Math.Clamp(frames, 0, 60); i++) yield return null;
        done(CaptureNow(maxWidth, jpg));
    }

    /// <summary>Только главный поток.</summary>
    public static byte[] CaptureNow(int maxWidth = 0, bool jpg = false)
    {
        var tex = ScreenCapture.CaptureScreenshotAsTexture();
        try
        {
            if (tex == null) throw new GameException("Игра не отдала кадр");
            if (maxWidth > 0 && tex.width > maxWidth)
            {
                var scaled = Scale(tex, maxWidth, Mathf.Max(1, Mathf.RoundToInt(tex.height * (maxWidth / (float)tex.width))));
                UnityEngine.Object.Destroy(tex);
                tex = scaled;
            }
            // Il2CppStructArray<byte> неявно приводится к byte[] (копия в управляемую память).
            byte[] bytes = jpg ? ImageConversion.EncodeToJPG(tex, 85) : ImageConversion.EncodeToPNG(tex);
            return bytes;
        }
        finally
        {
            if (tex != null) UnityEngine.Object.Destroy(tex);
        }
    }

    static Texture2D Scale(Texture2D source, int width, int height)
    {
        var rt = RenderTexture.GetTemporary(width, height, 0);
        var previous = RenderTexture.active;
        try
        {
            Graphics.Blit(source, rt);
            RenderTexture.active = rt;
            var result = new Texture2D(width, height, TextureFormat.RGB24, false);
            result.ReadPixels(new Rect(0, 0, width, height), 0, 0);
            result.Apply();
            return result;
        }
        finally
        {
            RenderTexture.active = previous;
            RenderTexture.ReleaseTemporary(rt);
        }
    }
}
