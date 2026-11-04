export function setupProfile({ api }) {
  const $ = (selector) => document.querySelector(selector);
  const dialog = $('#profile-dialog');
  const fields = $('#profile-fields');
  const save = $('#save-profile');
  const cancel = $('#cancel-profile');
  let profile = null, draftAvatar = null, editVersion = 0, saving = false;

  function avatar(target, image, username) {
    target.replaceChildren();
    if (image) {
      const img = document.createElement('img');
      img.src = image;
      img.alt = '';
      target.append(img);
    } else target.textContent = Array.from(username.trim())[0] || '我';
  }
  function render() {
    for (const name of document.querySelectorAll('[data-profile-name]')) name.textContent = profile.username;
    for (const target of document.querySelectorAll('.profile-avatar:not(#profile-avatar-preview)')) avatar(target, profile.avatar, profile.username);
  }
  function preview() {
    avatar($('#profile-avatar-preview'), draftAvatar, $('#profile-username').value);
    $('#remove-avatar').disabled = !draftAvatar;
  }
  function busy(value) {
    fields.disabled = save.disabled = value;
  }
  async function load() {
    try {
      profile = await api('/api/profile');
      render();
      $('#profile-status').textContent = '阅读、整理与积累';
    } catch {
      $('#profile-status').textContent = '个人资料加载失败，请点击“编辑资料”重试。';
    }
  }
  const initialLoad = load();

  $('#edit-profile').addEventListener('click', async () => {
    const version = ++editVersion;
    $('#profile-error').textContent = '';
    $('#avatar-input').value = '';
    busy(true);
    dialog.showModal();
    await initialLoad;
    if (!profile) await load();
    if (version !== editVersion) return;
    if (!profile) {
      $('#profile-error').textContent = '无法加载个人资料，请关闭后重试。';
      return;
    }
    $('#profile-username').value = profile.username;
    draftAvatar = profile.avatar;
    preview();
    busy(false);
    $('#profile-username').focus();
  });
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', (event) => { if (saving) event.preventDefault(); });
  dialog.addEventListener('close', () => { ++editVersion; $('#avatar-input').value = ''; });
  $('#profile-username').addEventListener('input', preview);
  $('#choose-avatar').addEventListener('click', () => $('#avatar-input').click());
  $('#remove-avatar').addEventListener('click', () => {
    draftAvatar = null;
    $('#avatar-input').value = '';
    $('#profile-error').textContent = '';
    preview();
  });
  $('#avatar-input').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    event.target.value = '';
    $('#profile-error').textContent = '';
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      $('#profile-error').textContent = '请选择 PNG、JPEG 或 WebP 格式的头像';
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      $('#profile-error').textContent = '头像不能超过 2 MB';
      return;
    }
    const version = editVersion;
    busy(true);
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
      if (version !== editVersion) return;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      const size = Math.min(bitmap.width, bitmap.height);
      canvas.getContext('2d').drawImage(bitmap, (bitmap.width - size) / 2, (bitmap.height - size) / 2, size, size, 0, 0, 256, 256);
      draftAvatar = canvas.toDataURL('image/png');
      preview();
    } catch {
      if (version === editVersion) $('#profile-error').textContent = '无法读取这张图片，请选择有效的图片文件';
    } finally {
      bitmap?.close();
      if (version === editVersion) busy(false);
    }
  });
  $('#profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (save.disabled || !profile) return;
    const username = $('#profile-username').value.trim();
    $('#profile-error').textContent = '';
    if (!username) {
      $('#profile-error').textContent = '请输入用户名';
      $('#profile-username').focus();
      return;
    }
    saving = true;
    busy(true);
    cancel.disabled = true;
    save.textContent = '正在保存…';
    try {
      profile = await api('/api/profile', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, avatar: draftAvatar }),
      });
      render();
      $('#profile-status').textContent = '个人资料已保存';
      dialog.close();
    } catch (error) {
      $('#profile-error').textContent = error.message;
    } finally {
      saving = false;
      busy(false);
      cancel.disabled = false;
      save.textContent = '保存资料';
    }
  });
}
