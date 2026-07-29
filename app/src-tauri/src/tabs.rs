use std::sync::{Arc, Mutex};

use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Position, Rect, Size, Url, Webview,
    WebviewBuilder, WebviewUrl, Window,
};

const TAB_BAR_HEIGHT: f64 = 38.0;
const DEFAULT_SPLIT: f64 = 0.55;
const TAB_BAR_LABEL: &str = "tab-bar";

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
    tab_bar: Option<Webview>,
    tabs: Vec<Tab>,
    active_id: Option<String>,
    split: f64,
    next_id: usize,
}

impl TabManager {
    pub fn new(window: Window, main: Webview) -> Self {
        Self {
            window,
            main,
            tab_bar: None,
            tabs: Vec::new(),
            active_id: None,
            split: DEFAULT_SPLIT,
            next_id: 1,
        }
    }

    fn ensure_tab_bar(&mut self) -> Result<&Webview, String> {
        if self.tab_bar.is_none() {
            let size = self
                .window
                .inner_size()
                .map_err(|e| e.to_string())?
                .to_logical(self.window.scale_factor().unwrap_or(1.0));
            let builder = WebviewBuilder::new(TAB_BAR_LABEL, WebviewUrl::App("tabs.html".into()));
            let webview = self
                .window
                .add_child(
                    builder,
                    LogicalPosition::new(0.0, 0.0),
                    LogicalSize::new(size.width, TAB_BAR_HEIGHT),
                )
                .map_err(|e| e.to_string())?;
            let _ = webview.set_auto_resize(false);
            self.tab_bar = Some(webview);
        }
        Ok(self.tab_bar.as_ref().unwrap())
    }

    fn window_logical_size(&self) -> Result<LogicalSize<f64>, String> {
        let sf = self.window.scale_factor().unwrap_or(1.0);
        let size = self.window.inner_size().map_err(|e| e.to_string())?;
        Ok(size.to_logical(sf))
    }

    fn layout(&mut self) -> Result<(), String> {
        let size = self.window_logical_size()?;
        let tab_bar = self.ensure_tab_bar()?;
        tab_bar
            .set_bounds(Rect {
                position: Position::Logical(LogicalPosition::new(0.0, 0.0)),
                size: Size::Logical(LogicalSize::new(size.width, TAB_BAR_HEIGHT)),
            })
            .map_err(|e| e.to_string())?;

        if self.tabs.is_empty() {
            self.hide_all_browser_panes();
            self.main
                .set_bounds(Rect {
                    position: Position::Logical(LogicalPosition::new(0.0, TAB_BAR_HEIGHT)),
                    size: Size::Logical(LogicalSize::new(
                        size.width,
                        (size.height - TAB_BAR_HEIGHT).max(0.0),
                    )),
                })
                .map_err(|e| e.to_string())?;
            let _ = self.main.show();
        } else {
            let browser_height = ((size.height - TAB_BAR_HEIGHT) * self.split).max(120.0);
            let spa_top = TAB_BAR_HEIGHT + browser_height;
            let spa_height = (size.height - spa_top).max(0.0);

            for tab in &self.tabs {
                if Some(&tab.view.id) == self.active_id.as_ref() {
                    tab.webview
                        .set_bounds(Rect {
                            position: Position::Logical(LogicalPosition::new(0.0, TAB_BAR_HEIGHT)),
                            size: Size::Logical(LogicalSize::new(size.width, browser_height)),
                        })
                        .map_err(|e| e.to_string())?;
                    let _ = tab.webview.show();
                } else {
                    let _ = tab.webview.hide();
                }
            }

            self.main
                .set_bounds(Rect {
                    position: Position::Logical(LogicalPosition::new(0.0, spa_top)),
                    size: Size::Logical(LogicalSize::new(size.width, spa_height)),
                })
                .map_err(|e| e.to_string())?;
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
        let Some(tab_bar) = self.tab_bar.as_ref() else {
            return;
        };
        let list: Vec<&TabView> = self.tabs.iter().map(|t| &t.view).collect();
        let payload = match serde_json::to_string(&(&list, self.active_id.as_deref())) {
            Ok(s) => s,
            Err(_) => return,
        };
        let _ = tab_bar.eval(format!("if(window.updateTabs)window.updateTabs({payload})"));
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
        let browser_height = ((size.height - TAB_BAR_HEIGHT) * self.split).max(120.0);
        let label = format!("browser-{id}");
        let builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed));
        let webview = self
            .window
            .add_child(
                builder,
                LogicalPosition::new(0.0, TAB_BAR_HEIGHT),
                LogicalSize::new(size.width, browser_height),
            )
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
        self.active_id = Some(id.clone());
        self.layout()?;
        Ok(id)
    }

    pub fn close_tab(&mut self, id: &str) -> Result<(), String> {
        let pos = self.tabs.iter().position(|t| t.view.id == id);
        if let Some(pos) = pos {
            let tab = self.tabs.remove(pos);
            let _ = tab.webview.close();
            if self.active_id.as_deref() == Some(id) {
                self.active_id = self
                    .tabs
                    .get(pos.saturating_sub(1))
                    .or_else(|| self.tabs.first())
                    .map(|t| t.view.id.clone());
            }
            self.layout()?;
        }
        Ok(())
    }

    pub fn activate_tab(&mut self, id: &str) -> Result<(), String> {
        if self.tabs.iter().any(|t| t.view.id == id) {
            self.active_id = Some(id.to_string());
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
    let main = window
        .webviews()
        .into_iter()
        .next()
        .ok_or("main webview not found")?;
    let _ = main.set_auto_resize(false);
    let manager = Arc::new(Mutex::new(TabManager::new(window, main)));
    Ok(manager)
}
