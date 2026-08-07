import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Same-origin, GET-only proxy for the local Monitor API.  It deliberately
 * does not forward browser Origin, cookies, authorization, or arbitrary
 * target URLs.  Monitor itself remains bound to 127.0.0.1.
 */
public final class MonitorProxyServlet extends HttpServlet {
  private static final String UPSTREAM = "http://127.0.0.1:4319/api";

  @Override
  protected void doGet(HttpServletRequest request, HttpServletResponse response)
      throws IOException {
    String path = request.getPathInfo();
    if (path == null || !path.startsWith("/") || path.contains("..")) {
      response.sendError(HttpServletResponse.SC_BAD_REQUEST);
      return;
    }
    String target = UPSTREAM + path;
    if (request.getQueryString() != null && !request.getQueryString().isEmpty()) {
      target += "?" + request.getQueryString();
    }

    HttpURLConnection upstream = (HttpURLConnection) new URL(target).openConnection();
    upstream.setRequestMethod("GET");
    upstream.setConnectTimeout(5000);
    upstream.setReadTimeout(0);
    upstream.setRequestProperty("Accept", request.getHeader("Accept") == null ? "application/json" : request.getHeader("Accept"));
    String lastEventId = request.getHeader("Last-Event-ID");
    if (lastEventId != null) upstream.setRequestProperty("Last-Event-ID", lastEventId);

    int status = upstream.getResponseCode();
    response.setStatus(status);
    copyHeader(upstream, response, "Content-Type");
    copyHeader(upstream, response, "Cache-Control");
    copyHeader(upstream, response, "Last-Event-ID");
    response.setHeader("X-Accel-Buffering", "no");
    try (InputStream input = status >= 400 ? upstream.getErrorStream() : upstream.getInputStream();
         OutputStream output = response.getOutputStream()) {
      if (input == null) return;
      byte[] buffer = new byte[8192];
      for (int read; (read = input.read(buffer)) != -1;) {
        output.write(buffer, 0, read);
        output.flush();
      }
    } finally {
      upstream.disconnect();
    }
  }

  @Override
  protected void doOptions(HttpServletRequest request, HttpServletResponse response) {
    response.setHeader("Allow", "GET, OPTIONS");
    response.setStatus(HttpServletResponse.SC_NO_CONTENT);
  }

  @Override
  protected void doHead(HttpServletRequest request, HttpServletResponse response) throws IOException {
    response.sendError(HttpServletResponse.SC_METHOD_NOT_ALLOWED);
  }

  @Override
  protected void doPost(HttpServletRequest request, HttpServletResponse response) throws IOException {
    response.sendError(HttpServletResponse.SC_METHOD_NOT_ALLOWED);
  }

  @Override
  protected void doPut(HttpServletRequest request, HttpServletResponse response) throws IOException {
    response.sendError(HttpServletResponse.SC_METHOD_NOT_ALLOWED);
  }

  @Override
  protected void doDelete(HttpServletRequest request, HttpServletResponse response) throws IOException {
    response.sendError(HttpServletResponse.SC_METHOD_NOT_ALLOWED);
  }

  private static void copyHeader(HttpURLConnection source, HttpServletResponse target, String name) {
    String value = source.getHeaderField(name);
    if (value != null) target.setHeader(name, value);
  }
}
