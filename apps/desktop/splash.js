if (new URLSearchParams(location.search).get('state') === 'error') {
  document.body.classList.add('failed');
  document.querySelector('.recovery').hidden = false;
  const messages = {
    'bridge-incompatible': 'Bridge 协议或认证模式不兼容。请安装兼容协议 1 的 Bridge，保留现有 runtime.json 和状态目录。',
    'bridge-missing': '未找到 Bridge 用户服务。请安装独立 Bridge DEB，核对 runtime.json 与现有状态目录后按安装说明注册服务。',
    'bridge-service-migration': 'Bridge 用户服务仍使用旧入口或自定义入口。请先备份配置和 SQLite，再按升级说明受控切换服务。',
    'bridge-service': 'Bridge 用户服务无法启动。请检查官方 Codex、runtime.json 和 systemctl --user status oraculum-bridge.service。',
  };
  const message = messages[new URLSearchParams(location.search).get('reason')];
  if (message) document.querySelector('.recovery-detail').textContent = message;
}
