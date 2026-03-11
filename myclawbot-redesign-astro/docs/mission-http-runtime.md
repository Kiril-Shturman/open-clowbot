# Mission Control HTTP Runtime — MVP

Минимальная архитектура для связки:
- **Human / Founder**
- **COO / Commander**
- **Worker / Executor**
- **Mission Control UI**

Главная идея:
- человек ставит задачу через UI или Telegram
- COO принимает миссию
- COO отправляет задачу Worker-у по HTTP
- Worker отвечает `accepted | in_progress | done | blocked`
- COO решает следующий шаг
- UI показывает живой статус

---

## 1. Роли

### Founder
Ставит цель и утверждает приоритет.

### COO
- принимает миссию
- дробит её на шаги
- отправляет task Worker-у
- делает periodic check-ins
- решает, что делать дальше
- закрывает миссию

### Worker
- получает task
- делает тяжёлую работу
- возвращает статус / результат / blocker

---

## 2. Минимальные сущности

### Mission
```json
{
  "id": "m_001",
  "title": "Собрать 10 кейсов использования OpenClaw",
  "goal": "Подготовить список кейсов для контента и сайта",
  "priority": "high",
  "status": "active",
  "createdAt": "2026-03-11T06:50:00Z"
}
```

### Task
```json
{
  "id": "t_001",
  "mission_id": "m_001",
  "assigned_by": "coo",
  "assigned_to": "worker",
  "title": "Найти 10 кейсов использования OpenClaw для предпринимателей",
  "expected_output": "Список кейсов с коротким описанием",
  "status": "queued"
}
```

### Status report
```json
{
  "task_id": "t_001",
  "status": "in_progress",
  "progress": 60,
  "note": "Найдено 7 кейсов, собираю ещё 3"
}
```

### Result
```json
{
  "task_id": "t_001",
  "status": "done",
  "result": {
    "items": [
      { "title": "...", "summary": "..." }
    ]
  }
}
```

### Blocker
```json
{
  "task_id": "t_001",
  "status": "blocked",
  "blocker": "Нужен дополнительный входной контекст",
  "needed": "Уточнить, нужны ли кейсы только из YouTube или вообще из web"
}
```

---

## 3. HTTP endpoints

## COO-side API

### `POST /api/missions`
Создать новую миссию.

Request:
```json
{
  "title": "Собрать 10 кейсов использования OpenClaw",
  "goal": "Подготовить идеи для сайта и Reels",
  "priority": "high"
}
```

Response:
```json
{
  "ok": true,
  "mission": {
    "id": "m_001",
    "status": "active"
  }
}
```

### `GET /api/missions/:missionId`
Получить состояние миссии.

### `GET /api/missions/:missionId/log`
Получить лог событий миссии.

### `POST /api/missions/:missionId/check-in`
Принудительный check-in от COO.

---

## Worker-side API

### `POST /worker/tasks`
Отправить задачу worker-у.

Request:
```json
{
  "task_id": "t_001",
  "mission_id": "m_001",
  "title": "Найти 10 кейсов использования OpenClaw для предпринимателей",
  "expected_output": "Список кейсов с коротким описанием",
  "priority": "high"
}
```

Response:
```json
{
  "ok": true,
  "status": "accepted",
  "task_id": "t_001"
}
```

### `GET /worker/tasks/:taskId`
Получить текущий статус task.

Response examples:

#### accepted
```json
{
  "task_id": "t_001",
  "status": "accepted"
}
```

#### in_progress
```json
{
  "task_id": "t_001",
  "status": "in_progress",
  "progress": 40,
  "note": "Собираю первые кейсы"
}
```

#### blocked
```json
{
  "task_id": "t_001",
  "status": "blocked",
  "blocker": "Не хватает входных критериев",
  "needed": "Уточнить тип кейсов"
}
```

#### done
```json
{
  "task_id": "t_001",
  "status": "done",
  "result": {
    "items": [
      { "title": "Кейс 1", "summary": "..." },
      { "title": "Кейс 2", "summary": "..." }
    ]
  }
}
```

---

## 4. Логика цикла

### Шаг 1
Founder создаёт миссию.

### Шаг 2
COO создаёт первый task и отправляет его Worker-у.

### Шаг 3
Worker отвечает `accepted`.

### Шаг 4
COO по таймеру или вручную делает `check-in`.

### Шаг 5
COO читает `GET /worker/tasks/:taskId`.

### Шаг 6
Если `done`:
- сохраняет результат
- создаёт следующий task
- или закрывает миссию

### Шаг 7
Если `blocked`:
- пишет blocker в mission log
- уточняет задачу
- или эскалирует человеку

---

## 5. Что должен показывать Mission Control UI

### Верхний блок
- название миссии
- статус миссии
- следующий check-in
- текущий приказ COO

### Средний блок
- текущий active task
- статус Worker
- progress
- note / blocker

### Нижний блок
- mission log
- completed artifacts
- blockers

---

## 6. Минимальный roadmap

### Версия 1
- mission store
- task store
- fake worker endpoint
- real COO polling logic
- Mission Control UI поверх store

### Версия 2
- настоящий Worker endpoint
- real progress updates
- blockers
- result artifacts

### Версия 3
- несколько worker-ов
- role routing
- priorities / retries / queueing

---

## 7. Жёсткий вывод

Внутренний транспорт между ботами должен идти **через HTTP/JSON**, а не через Telegram-группу.

Telegram / UI — только для человека.
HTTP — для агента к агенту.
