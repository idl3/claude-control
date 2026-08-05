use std::sync::{Arc, Mutex};

#[cfg(target_os = "linux")]
use gtk::prelude::*;

use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Position, Rect, Size, Url, Webview,
    WebviewBuilder, WebviewUrl, Window,
};

const TAB_BAR_HEIGHT: f64 = 38.0;
const TAB_BAR_LABEL: &str = "tab-bar";
const CHATS_ID: &str = "chats";
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) ClaudeControlShell/0.1.0";

#[cfg(target_os = "linux")]
fn ensure_gtk_fixed_parent<W: IsA<gtk::Widget>>(widget: &W) -> Option<gtk::Fixed> {
    if let Some(parent) = widget.parent() {
        if let Some(fixed) = parent.downcast_ref::<gtk::Fixed>() {
            return Some(fixed.clone());
        }
        if let Some(vbox) = parent.downcast_ref::<gtk::Box>() {
            let fixed: gtk::Fixed = vbox
                .children()
                .iter()
                .find_map(|c| c.downcast_ref::<gtk::Fixed>().cloned())
                .unwrap_or_else(|| {
                    let f = gtk::Fixed::new();
                    vbox.pack_start(&f, true, true, 0);
                    f.show_all();
                    f
                });
            vbox.remove(widget);
            fixed.put(widget, 0, 0);
            widget.show();
            return Some(fixed);
        }
    }
    None
}

fn set_webview_bounds(webview: &Webview, window: &Window, bounds: Rect) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        webview.set_bounds(bounds).map_err(|e| e.to_string())?;
        let sf = window.scale_factor().unwrap_or(1.0);
        webview
            .with_webview(move |webview| {
                let gtk_wv = webview.inner();
                if let Some(fixed) = ensure_gtk_fixed_parent(&gtk_wv) {
                    let pos = bounds.position.to_logical::<i32>(sf);
                    let size = bounds.size.to_logical::<i32>(sf);
                    fixed.move_(&gtk_wv, pos.x, pos.y);
                    gtk_wv.set_size_request(size.width, size.height);
                }
            })
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        webview.set_bounds(bounds).map_err(|e| e.to_string())
    }
}

#[derive(Clone, serde::Serialize)]
struct TabView {
    id: String,
    url: String,
    title: String,
}

struct Tab {
    view: TabView,
    webview: Webview,
}

pub struct TabManager {
    window: Window,
    main: Webview,
    tab_bar: Webview,
    tabs: Vec<Tab>,
    active_id: String,
    next_id: usize,
}

impl TabManager {
    pub fn new(window: Window, tab_bar: Webview, main: Webview) -> Self {
        Self {
            window,
            main,
            tab_bar,
            tabs: Vec::new(),
            active_id: CHATS_ID.to_string(),
            next_id: 1,
        }
    }

    fn window_logical_size(&self) -> Result<LogicalSize<f64>, String> {
        let sf = self.window.scale_factor().unwrap_or(1.0);
        let size = self.window.inner_size().map_err(|e| e.to_string())?;
        Ok(size.to_logical(sf))
    }

    fn content_rect(&self, size: LogicalSize<f64>) -> Rect {
        Rect {
            position: Position::Logical(LogicalPosition::new(0.0, TAB_BAR_HEIGHT)),
            size: Size::Logical(LogicalSize::new(
                size.width,
                (size.height - TAB_BAR_HEIGHT).max(0.0_f64),
            )),
        }
    }

    fn layout(&mut self) -> Result<(), String> {
        let size = self.window_logical_size()?;
        let tab_bar_bounds = Rect {
            position: Position::Logical(LogicalPosition::new(0.0, 0.0)),
            size: Size::Logical(LogicalSize::new(size.width, TAB_BAR_HEIGHT)),
        };
        set_webview_bounds(&self.tab_bar, &self.window, tab_bar_bounds)?;

        let content = self.content_rect(size);

        if self.active_id == CHATS_ID {
            let _ = self.hide_all_browser_panes();
            set_webview_bounds(&self.main, &self.window, content)?;
            let _ = self.main.show();
        } else if self.tabs.iter().any(|t| t.view.id == self.active_id) {
            let _ = self.main.hide();
            for tab in &self.tabs {
                if tab.view.id == self.active_id {
                    set_webview_bounds(&tab.webview, &self.window, content)?;
                    let _ = tab.webview.show();
                } else {
                    let _ = tab.webview.hide();
                }
            }
        } else {
            // Unknown active tab -> fall back to Chats.
            self.active_id = CHATS_ID.to_string();
            let _ = self.hide_all_browser_panes();
            set_webview_bounds(&self.main, &self.window, content)?;
            let _ = self.main.show();
        }

        self.sync_tab_bar();
        Ok(())
    }

    fn hide_all_browser_panes(&self) {
        for tab in &self.tabs {
            let _ = tab.webview.hide();
        }
    }

    fn sync_tab_bar(&self) {
        let mut list = Vec::with_capacity(self.tabs.len() + 1);
        list.push(TabView {
            id: CHATS_ID.to_string(),
            url: String::new(),
            title: "Chats".to_string(),
        });
        list.extend(self.tabs.iter().map(|t| t.view.clone()));
        let tabs_json = match serde_json::to_string(&list) {
            Ok(s) => s,
            Err(_) => return,
        };
        let active_json = match serde_json::to_string(&self.active_id) {
            Ok(s) => s,
            Err(_) => return,
        };
        let _ = self.tab_bar.eval(format!(
            "if(window.updateTabs)window.updateTabs({tabs_json},{active_json})"
        ));
    }

    fn tab_title(url: &str) -> String {
        if let Ok(u) = Url::parse(url) {
            u.host_str()
                .map(|h| h.to_string())
                .unwrap_or_else(|| url.to_string())
        } else {
            url.to_string()
        }
    }

    pub fn open_tab(&mut self, url: String) -> Result<String, String> {
        let parsed = Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
        match parsed.scheme() {
            "http" | "https" => {}
            other => return Err(format!("refusing non-http(s) scheme: {other}")),
        }
        let id = format!("tab-{}", self.next_id);
        self.next_id += 1;

        let size = self.window_logical_size()?;
        let content = self.content_rect(size);
        let (position, size) = match (content.position, content.size) {
            (Position::Logical(p), Size::Logical(s)) => (p, s),
            _ => return Err("unexpected bounds type".into()),
        };

        let label = format!("browser-{id}");
        let builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed));
        let webview = self
            .window
            .add_child(builder, position, size)
            .map_err(|e| e.to_string())?;
        let _ = webview.set_auto_resize(false);

        self.tabs.push(Tab {
            view: TabView {
                id: id.clone(),
                url: url.clone(),
                title: Self::tab_title(&url),
            },
            webview,
        });
        self.active_id = id.clone();
        self.layout()?;
        Ok(id)
    }

    pub fn close_tab(&mut self, id: &str) -> Result<(), String> {
        if id == CHATS_ID {
            return Err("the Chats tab cannot be closed".into());
        }
        let pos = self.tabs.iter().position(|t| t.view.id == id);
        if let Some(pos) = pos {
            let tab = self.tabs.remove(pos);
            let _ = tab.webview.close();
            if self.active_id == id {
                self.active_id = CHATS_ID.to_string();
            }
            self.layout()?;
        }
        Ok(())
    }

    pub fn activate_tab(&mut self, id: &str) -> Result<(), String> {
        if id == CHATS_ID {
            self.active_id = CHATS_ID.to_string();
            self.layout()?;
            return Ok(());
        }
        if self.tabs.iter().any(|t| t.view.id == id) {
            self.active_id = id.to_string();
            self.layout()?;
        }
        Ok(())
    }

    pub fn broadcast_action(&self, action: &str) -> Result<(), String> {
        let event = match action {
            "reload" => "window.dispatchEvent(new CustomEvent('cc:reload-app'))",
            "settings" => "window.dispatchEvent(new CustomEvent('cc:open-settings'))",
            "processes" => "window.dispatchEvent(new CustomEvent('cc:open-processes'))",
            _ => return Err(format!("unknown action: {action}")),
        };
        self.main.eval(event).map_err(|e| e.to_string())
    }

    pub fn handle_resize(&mut self) -> Result<(), String> {
        self.layout()
    }
}

fn create_tab_bar(window: &Window) -> Result<Webview, String> {
    let sf = window.scale_factor().unwrap_or(1.0);
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let logical: LogicalSize<f64> = size.to_logical(sf);
    let builder = WebviewBuilder::new(TAB_BAR_LABEL, WebviewUrl::App("tabs.html".into()));
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(logical.width, TAB_BAR_HEIGHT),
        )
        .map_err(|e| e.to_string())?;
    let _ = webview.set_auto_resize(false);
    Ok(webview)
}

fn create_main(window: &Window) -> Result<Webview, String> {
    let sf = window.scale_factor().unwrap_or(1.0);
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let logical: LogicalSize<f64> = size.to_logical(sf);
    let builder = WebviewBuilder::new("main", WebviewUrl::App("index.html".into()))
        .user_agent(USER_AGENT);
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(0.0, TAB_BAR_HEIGHT),
            LogicalSize::new(logical.width, (logical.height - TAB_BAR_HEIGHT).max(0.0_f64)),
        )
        .map_err(|e| e.to_string())?;
    let _ = webview.set_auto_resize(false);
    Ok(webview)
}

#[tauri::command]
pub async fn open_browser_tab(
    url: String,
    tabs: tauri::State<'_, Arc<Mutex<TabManager>>>,
) -> Result<String, String> {
    tabs.lock().unwrap().open_tab(url)
}

#[tauri::command]
pub async fn close_browser_tab(
    id: String,
    tabs: tauri::State<'_, Arc<Mutex<TabManager>>>,
) -> Result<(), String> {
    tabs.lock().unwrap().close_tab(&id)
}

#[tauri::command]
pub async fn activate_browser_tab(
    id: String,
    tabs: tauri::State<'_, Arc<Mutex<TabManager>>>,
) -> Result<(), String> {
    tabs.lock().unwrap().activate_tab(&id)
}

#[tauri::command]
pub async fn shell_action(
    action: String,
    tabs: tauri::State<'_, Arc<Mutex<TabManager>>>,
) -> Result<(), String> {
    tabs.lock().unwrap().broadcast_action(&action)
}

pub fn init(app: &AppHandle) -> Result<Arc<Mutex<TabManager>>, String> {
    let window = app.get_window("main").ok_or("main window not found")?;
    // Close the default webview created from tauri.conf.json so we can control
    // child webview order. On Linux/GTK the pack order determines stacking, and
    // the tab bar must be created before the content webviews to appear on top.
    for w in window.webviews() {
        let _ = w.close();
    }
    let tab_bar = create_tab_bar(&window)?;
    let main = create_main(&window)?;
    let manager = Arc::new(Mutex::new(TabManager::new(window, tab_bar, main)));
    let _ = manager.lock().unwrap().handle_resize();
    Ok(manager)
}
