fn main() {
    // 앱 커맨드 ACL 매니페스트를 생성한다. Tauri v2에서 원격(remote) origin webview는
    // app command 호출 시 반드시 ACL 권한(allow-<command>)이 필요하며, 그 권한은
    // 여기 commands()에 나열해야 자동 생성된다. 매니페스트를 켜면 로컬 윈도의 커맨드도
    // ACL 대상이 되므로 capabilities/{default,target}.json에서 각 윈도가 호출하는
    // 커맨드를 allow-* 로 허용해야 한다.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "open_target",
                "on_pick",
                "start_field_pick",
                "on_field_pick",
                "request_extract",
                "start_collect",
                "collect_rows",
                "paginate_result",
                "page_ready",
                "robots_status",
                "set_consent",
                "export_csv",
                "export_json",
            ]),
        ),
    )
    .expect("failed to run tauri-build");
}
