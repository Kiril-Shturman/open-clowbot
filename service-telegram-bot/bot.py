import logging
import os
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import Application, CallbackQueryHandler, CommandHandler, ContextTypes

logging.basicConfig(
    format='%(asctime)s | %(levelname)s | %(name)s | %(message)s',
    level=logging.INFO,
)
logger = logging.getLogger('service-telegram-bot')

BOT_TOKEN = os.getenv('TELEGRAM_BOT_TOKEN', '').strip()
SUPPORT_URL = os.getenv('SUPPORT_URL', '').strip() or 'https://t.me/open_clawbot_support'
SETUP_URL = os.getenv('SETUP_URL', '').strip() or 'https://open-clawbot.ru/'
PROJECT_NAME = os.getenv('PROJECT_NAME', '').strip() or 'MyClawBot'


def start_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [InlineKeyboardButton('🤖 Как создать бота', callback_data='how_create_bot')],
        [InlineKeyboardButton('🆔 Узнать мой Telegram ID', callback_data='show_user_id')],
        [InlineKeyboardButton('🔑 Как подключить токен', callback_data='how_connect_token')],
        [InlineKeyboardButton('💬 Поддержка', callback_data='support')],
    ])


def start_text(user_first_name: str | None) -> str:
    name = user_first_name or 'друг'
    return (
        f'Привет, {name}! Я сервисный бот {PROJECT_NAME}.\n\n'
        'Я помогу быстро пройти онбординг:\n'
        '• создать Telegram-бота через BotFather\n'
        '• узнать свой Telegram ID\n'
        '• понять, куда вставлять токен\n'
        '• найти поддержку\n\n'
        'Выбери нужный пункт ниже.'
    )


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    await update.effective_message.reply_text(
        start_text(user.first_name if user else None),
        reply_markup=start_keyboard(),
    )


async def id_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    if not user:
        await update.effective_message.reply_text('Не удалось определить ваш Telegram ID.')
        return
    await update.effective_message.reply_text(
        f'Ваш Telegram ID: `{user.id}`',
        parse_mode='Markdown',
        reply_markup=start_keyboard(),
    )


async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.effective_message.reply_text(
        'Доступные команды:\n'
        '/start — главное меню\n'
        '/id — показать ваш Telegram ID\n'
        '/help — помощь',
        reply_markup=start_keyboard(),
    )


async def on_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()
    user = update.effective_user
    user_id = user.id if user else 'неизвестно'

    responses = {
        'how_create_bot': (
            'Как создать бота через BotFather:\n\n'
            '1. Открой Telegram и найди @BotFather\n'
            '2. Нажми /start\n'
            '3. Отправь команду /newbot\n'
            '4. Придумай имя бота\n'
            '5. Придумай username бота, который заканчивается на `bot`\n'
            '6. BotFather пришлёт тебе токен — сохрани его\n\n'
            'После этого вернись сюда или в кабинет и используй токен для подключения.'
        ),
        'show_user_id': f'Ваш Telegram ID: `{user_id}`',
        'how_connect_token': (
            'Как подключить токен:\n\n'
            '1. Создай бота в @BotFather\n'
            '2. Скопируй токен вида:\n'
            '`1234567890:ABCdefGHI_jklMNOpqrSTUVwx`\n'
            '3. Открой сайт/кабинет сервиса\n'
            '4. Вставь токен в форму подключения бота\n\n'
            f'Страница подключения: {SETUP_URL}'
        ),
        'support': (
            'Поддержка:\n\n'
            f'• Сайт / подключение: {SETUP_URL}\n'
            f'• Поддержка: {SUPPORT_URL}\n\n'
            'Если что-то не работает, напиши в поддержку и приложи:\n'
            '• ваш Telegram ID\n'
            '• описание проблемы\n'
            '• скриншот ошибки, если есть'
        ),
    }

    text = responses.get(query.data, 'Неизвестное действие.')
    await query.message.reply_text(text, parse_mode='Markdown', reply_markup=start_keyboard())


def main() -> None:
    if not BOT_TOKEN:
        raise RuntimeError('TELEGRAM_BOT_TOKEN is not set')

    app = Application.builder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler('start', start_command))
    app.add_handler(CommandHandler('id', id_command))
    app.add_handler(CommandHandler('help', help_command))
    app.add_handler(CallbackQueryHandler(on_callback))

    logger.info('Starting service Telegram bot')
    app.run_polling(drop_pending_updates=True)


if __name__ == '__main__':
    main()
