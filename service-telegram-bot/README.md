# Service Telegram Bot

Простой Telegram-бот для онбординга пользователей сервиса.

## Что умеет

- `/start` — приветствие + кнопки меню
- `/id` — показать Telegram ID пользователя
- `/help` — список команд
- Кнопки:
  - Как создать бота в BotFather
  - Узнать мой Telegram ID
  - Как подключить токен
  - Поддержка

## Файлы

- `bot.py` — основной код бота
- `requirements.txt` — Python-зависимости
- `.env.example` — пример переменных окружения

## Быстрый запуск

```bash
cd service-telegram-bot
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
cp .env.example .env
```

Заполни `.env`, затем:

```bash
set -a
. ./.env
set +a
python bot.py
```

## Нужные переменные

- `TELEGRAM_BOT_TOKEN` — токен сервисного Telegram-бота
- `PROJECT_NAME` — название сервиса
- `SETUP_URL` — ссылка на сайт / страницу подключения
- `SUPPORT_URL` — ссылка на поддержку

## Что можно добавить потом

- приём токена от пользователя
- сохранение заявок в БД
- webhook вместо polling
- FAQ / тарифы / статус сервиса
- связку с кабинетом
