// Last One Wins — notification-only service worker.
// Handles push events and notification clicks. No fetch interception or caching.

self.addEventListener("push", function (event) {
  if (!event.data) return;
  var data;
  try { data = event.data.json(); } catch (_) { return; }
  var options = {
    body: data.body || "",
    tag: data.tag || "lastwin",
    data: { url: data.url || "/" },
  };
  if (data.icon) options.icon = data.icon;
  event.waitUntil(
    self.registration.showNotification(data.title || "Last One Wins", options)
  );
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if ("focus" in list[i]) return list[i].focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
