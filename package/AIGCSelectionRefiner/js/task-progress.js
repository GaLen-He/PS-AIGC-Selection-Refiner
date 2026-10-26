(function (root) {
  function removableIds(tasks, running) {
    return (tasks || []).filter(function (task) {
      return task && task.id && (task.lastRecoveryError || task.recoveryBlocked || task.recoveryExhausted || task.autoResume === false) && !(running && running[task.id]);
    }).map(function (task) { return task.id; });
  }

  function snapshot(tasks, oldestFirst, running) {
    var stages = { waiting: ['平台生成中', 0], downloading: ['下载结果', 1], downloaded: ['处理图像', 2],
      restored: ['处理图像', 2], prepared: ['等待后台回贴', 3], placing: ['后台回贴', 4] };
    var model = { active: 0, paused: 0, rows: [] };
    (tasks || []).forEach(function (task) {
      if (!task || !task.id) return;
      var inFlight = !!(running && running[task.id]);
      var paused = !inFlight && !!(task.lastRecoveryError || task.recoveryBlocked || task.recoveryExhausted || task.autoResume === false);
      var source = task.type === 'layer' ? task.exportInfo : task.context;
      var stage = stages[task.stage] || ['等待恢复', 0];
      var error = task.lastRecoveryError;
      var detail = error ? '[' + (error.phase || task.stage || 'unknown') + '] ' + error.message : '';
      if (error && error.compatibilityError) detail += '\n兼容写入 [' + (error.compatibilityPhase || 'unknown') + '] ' + error.compatibilityError;
      if (error && error.rollbackError) detail += '\n回滚失败：' + error.rollbackError;
      model[paused ? 'paused' : 'active'] += 1;
      model.rows.push({ id: task.id, title: task.type === 'layer' ? '分层 · ' + (task.job && task.job.name || '图层') : '选区 #' + (task.jobNumber || '—'),
        document: source && source.source && source.source.name || '', label: paused ? '已暂停 · ' + stage[0] : stage[0],
        paused: paused, step: stage[1], percent: null,
        error: detail, message: !error && task.recoveryMessage || '',
        createdAt: task.createdAt || 0, updatedAt: task.updatedAt || task.createdAt || 0 });
    });
    model.rows.sort(function (first, second) {
      return oldestFirst ? first.createdAt - second.createdAt : second.createdAt - first.createdAt;
    });
    return model;
  }

  function render(document, tasks, retry, running, options) {
    options = options || {};
    var list = document.getElementById('taskProgressList');
    var summary = document.getElementById('taskProgressSummary');
    if (!list || !summary) return;
    var model = snapshot(tasks, options.oldestFirst, running);
    var removable = removableIds(tasks, running);
    summary.textContent = '任务进度 · 进行中 ' + model.active + ' / 暂停 ' + model.paused;
    var launcher = document.getElementById('taskProgressButton');
    if (launcher) launcher.textContent = '任务列表（' + model.rows.length + '/20）';
    var clearButton = document.getElementById('clearPausedTasksButton');
    if (clearButton) clearButton.disabled = !removable.length;
    while (list.firstChild) list.removeChild(list.firstChild);
    if (!model.rows.length) {
      var empty = document.createElement('p');
      empty.textContent = '没有待取回任务';
      list.appendChild(empty);
    }
    model.rows.forEach(function (row) {
      var card = document.createElement('section');
      card.className = 'taskProgressCard' + (row.paused ? ' paused' : '');
      var title = document.createElement('strong');
      title.textContent = row.title;
      card.appendChild(title);
      var label = document.createElement('div');
      label.textContent = row.label + (row.document ? ' · ' + row.document : '');
      card.appendChild(label);
      var bar = document.createElement('div');
      bar.className = 'taskStepBar';
      bar.setAttribute('aria-label', '阶段 ' + (row.step + 1) + '/5：' + row.label);
      for (var step = 0; step < 5; step += 1) {
        var segment = document.createElement('span');
        segment.className = step < row.step ? 'done' : step === row.step ? (row.paused ? 'stopped' : 'current') : '';
        bar.appendChild(segment);
      }
      card.appendChild(bar);
      if (row.message) {
        var status = document.createElement('div');
        status.className = 'taskMessage';
        status.setAttribute('role', 'status');
        status.textContent = row.message;
        card.appendChild(status);
      }
      if (row.error) {
        var message = document.createElement('p');
        message.className = 'taskError';
        message.textContent = row.error;
        card.appendChild(message);
      }
      if (row.error || row.paused || running && running[row.id]) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary compact';
        button.textContent = running && running[row.id] ? '正在取回…' : '重试此任务';
        button.disabled = !!(running && running[row.id]);
        button.addEventListener('click', function () { retry(row.id); });
        card.appendChild(button);
      }
      if (options.dismiss && removable.indexOf(row.id) >= 0) {
        var dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.className = 'secondary compact taskDismiss';
        dismiss.textContent = '清除此任务';
        dismiss.addEventListener('click', function () { options.dismiss(row.id); });
        card.appendChild(dismiss);
      }
      list.appendChild(card);
    });
  }

  var api = { snapshot: snapshot, render: render, removableIds: removableIds };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AIGCTaskProgress = api;
})(this);
