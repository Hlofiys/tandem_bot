// Импорт необходимых библиотек
import { Telegraf, Markup, Context, session } from 'telegraf';
import { Pool } from 'pg';
import { BotCommand } from 'telegraf/types';

interface SessionData {
    step?: string;
    userId?: number;
    selectedRow?: number;
    selectedSection?: string;
    selectedSeat?: number;
    selectedSeats?: { section: string; row: number; seat: number }[];
}

interface TgContext extends Context {
    session?: SessionData;
}

var token = process.env.BOT_TOKEN;
if(token == undefined) {
    console.error('Token is not defined');
}
// Инициализация Telegram Bot API
const bot = new Telegraf<TgContext>(token!);
bot.use(session());

// Define the bot commands
const commands: BotCommand[] = [
    { command: 'start', description: 'Запустить бота' },
    { command: 'book', description: 'Начать бронирование' },
    { command: 'mybookings', description: 'Посмотреть забронированные места' },
    { command: 'cancel', description: 'Отменить бронь' },
];

// Set the bot commands when the bot starts
bot.telegram.setMyCommands(commands)
    .then(() => {
        console.log('Bot commands set successfully.');
    })
    .catch((error) => {
        console.error('Error setting bot commands:', error);
    });

// Инициализация подключения к базе данных PostgreSQL
const pool = new Pool({
    user: 'postgres',
    host: 'tandem_db',
    database: 'bot',
    password: 'postgres',
    port: 5432,
});

// Создание таблиц для хранения данных (выполняется один раз)
(async () => {
    const client = await pool.connect();
    try {
        await client.query(`
      CREATE TABLE IF NOT EXISTS sections (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rows (
        id SERIAL PRIMARY KEY,
        section_id INTEGER NOT NULL REFERENCES sections(id),
        row_number INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        full_name TEXT NOT NULL,
        phone_number TEXT NOT NULL UNIQUE,
        telegram_id BIGINT NOT NULL UNIQUE
      );

      CREATE TABLE IF NOT EXISTS seats (
        id SERIAL PRIMARY KEY,
        row_id INTEGER NOT NULL REFERENCES rows(id),
        seat_number INTEGER NOT NULL,
        is_booked BOOLEAN DEFAULT FALSE,
        booked_by INTEGER REFERENCES users(id)
      );
    `);
    } catch (error) {
        console.error('Error creating tables:', error);
    } finally {
        client.release();
    }
})();

// Обработчик команды /start
bot.start(async (ctx) => {
    ctx.reply('Добро пожаловать в систему бронирования билетов! Введите /book для начала бронирования.');
});

// Обработчик команды /book
const BOOKING_STEPS = {
    SELECT_SECTION: 'select_section',
    SELECT_ROW: 'select_row',
    SELECT_SEAT: 'select_seat',
    CONFIRM: 'confirm',
};

// Обработчик команды /book
bot.command('book', async (ctx) => {
    ctx.session = { selectedSeats: [], step: BOOKING_STEPS.SELECT_SECTION };
    const sections = await getSections();

    if (sections.length === 0) {
        return ctx.reply('Нет доступных секций.');
    }

    const sectionButtons = sections.map((section) =>
        Markup.button.callback(section.name, `section_${section.name}`)
    );

    return ctx.reply('Выберите секцию:', Markup.inlineKeyboard(sectionButtons, { columns: 2 }));
});

// Обработчики кнопок выбора секции, ряда и места
bot.action(/section_(.+)/, async (ctx) => {
    const sectionName = ctx.match[1];
    if (ctx.session == undefined) {
        return ctx.reply('Введите /book для начала бронирования.');
    }
    ctx.session.selectedSection = sectionName;
    ctx.session.step = BOOKING_STEPS.SELECT_ROW;

    const rows = await getRows(sectionName);
    const sectionButtons = rows.map((row) =>
        Markup.button.callback(`Ряд ${row.row_number}`, `row_${sectionName}_${row.row_number}`)
    );
    sectionButtons.push(Markup.button.callback('Назад', 'back_to_section'));
    sectionButtons.push(Markup.button.callback('Отмена', 'cancel_booking')); // Add cancel button

    const selectedSeatsString = getSelectedSeatsString(ctx);
    return ctx.editMessageText(`Для подтверждения брони введите /confirm\nВыбранные места:\n${selectedSeatsString}\n\nТекущий выбор:\nCекция ${sectionName}\nВыберите ряд:`, Markup.inlineKeyboard(sectionButtons, { columns: 3 }));
});

bot.action(/row_(.+)_(.+)/, async (ctx) => {
    const sectionName = (ctx.match[1]);
    const rowNumber = (ctx.match[2]);
    if (ctx.session == undefined) {
        return ctx.reply('Введите /book для начала бронирования.');
    }
    ctx.session.selectedRow = parseInt(rowNumber, 10);
    ctx.session.step = BOOKING_STEPS.SELECT_SEAT;
    const seats = await getSeats(sectionName, parseInt(rowNumber, 10));
    const rowButtons = seats.map((seat) =>
        Markup.button.callback(`Место ${seat.seat_number}`, `seat_${sectionName}_${parseInt(rowNumber, 10)}_${seat.seat_number}`)
    );
    rowButtons.push(Markup.button.callback('Назад', `back_to_row_${sectionName}`));
    rowButtons.push(Markup.button.callback('Отмена', 'cancel_booking')); // Add cancel button

    const selectedSeatsString = getSelectedSeatsString(ctx);
    ctx.editMessageText(`Для подтверждения брони введите /confirm\nВыбранные места:\n${selectedSeatsString}\n\nТекущий выбор:\nCекция ${sectionName}, Ряд ${rowNumber}\nВыберите место:`, Markup.inlineKeyboard(rowButtons, { columns: 3 }));
});


bot.action(/seat_(.+)_(.+)_(.+)/, async (ctx) => {
    const [sectionName, rowNumber, seatNumber] = ctx.match.slice(1);
    if (!ctx.session || !ctx.session.selectedSeats) {
        return ctx.reply('Введите /book для начала бронирования.');
    }

    const seatInfo = {
        section: sectionName,
        row: parseInt(rowNumber, 10),
        seat: parseInt(seatNumber, 10),
    };

    if (ctx.session.selectedSeats.some(s => s.section === seatInfo.section && s.row === seatInfo.row && s.seat === seatInfo.seat)) {
        // If seat is already selected, inform the user but DON'T add it again
        ctx.answerCbQuery(`Место ${seatNumber} уже выбрано.`); // Use answerCbQuery for short feedback
        return; // Stop further processing
    }

    ctx.session.selectedSeats.push(seatInfo);
    const selectedSeatsString = ctx.session.selectedSeats.map(s => `Секция ${s.section}, Ряд ${s.row}, Место ${s.seat}`).join('\n');

    const seats = await getSeats(sectionName, parseInt(rowNumber, 10));
    const seatButtons = seats.map((seat) =>
        Markup.button.callback(`Место ${seat.seat_number}`, `seat_${sectionName}_${parseInt(rowNumber, 10)}_${seat.seat_number}`)
    );
    seatButtons.push(Markup.button.callback('Назад', `back_to_row_${sectionName}`));
    seatButtons.push(Markup.button.callback('Отмена', `cancel_booking`));

    ctx.editMessageText(`Для подтверждения брони введите /confirm\nВыбранные места:\n${selectedSeatsString}\n\nТеущий выбор:\nСекция ${sectionName}, Ряд ${rowNumber}\nВыберите место:`,
        Markup.inlineKeyboard(seatButtons, { columns: 3 }));

    await ctx.answerCbQuery(); // Acknowledge the callback query to prevent "Loading..."
});

async function getSections() {
    const client = await pool.connect();
    try {
        const { rows } = await client.query('SELECT name FROM sections');
        return rows;
    } finally {
        client.release();
    }
}


async function getRows(sectionName: string) {
    const client = await pool.connect();
    try {
        const { rows } = await client.query(
            'SELECT rows.row_number FROM rows JOIN sections ON rows.section_id = sections.id WHERE sections.name = $1',
            [sectionName]
        );
        return rows;
    } finally {
        client.release();
    }
}



async function getSeats(sectionName: string, rowNumber: number) {
    const client = await pool.connect();
    try {
        const { rows } = await client.query(
            `SELECT seats.seat_number
             FROM seats
             JOIN rows ON seats.row_id = rows.id
             JOIN sections ON rows.section_id = sections.id
             WHERE sections.name = $1
             AND rows.row_number = $2
             AND seats.is_booked = FALSE
             ORDER BY seats.seat_number;`, // Добавляем ORDER BY
            [sectionName, rowNumber]
        );
        return rows;
    } finally {
        client.release();
    }
}

function getSelectedSeatsString(ctx: TgContext) {
    return ctx.session && ctx.session.selectedSeats ? ctx.session.selectedSeats.map(s => `Секция ${s.section}, Ряд ${s.row}, Место ${s.seat}`).join('\n') : "";
}

// Обработчики кнопок "Назад"
bot.action('back_to_section', async (ctx) => {
    if (ctx.session == undefined) {
        return ctx.reply('Введите /book для начала бронирования.');
    }
    ctx.session.step = BOOKING_STEPS.SELECT_SECTION;
    const sections = await getSections();

    if (sections.length === 0) {
        return ctx.reply('Нет доступных секций.');
    }

    const sectionButtons = sections.map((section) =>
        Markup.button.callback(section.name, `section_${section.name}`)
    );

    const selectedSeatsString = getSelectedSeatsString(ctx);
    return ctx.editMessageText(`Для подтверждения брони введите /confirm\nВыбранные места:\n${selectedSeatsString}\nВыберите секцию:`, Markup.inlineKeyboard(sectionButtons, { columns: 2 }));

});

// Add cancel_booking action
bot.action('cancel_booking', async (ctx) => {
    if (ctx.session) {
        ctx.session.selectedSeats = [];
        ctx.session.step = undefined;
    }
    ctx.editMessageText('Бронирование отменено.');
    await ctx.answerCbQuery();  // Important: Acknowledge the callback query
});

bot.action(/back_to_row_(.+)/, async (ctx) => {
    const sectionName = ctx.match[1];
    if (!ctx.session) {
        return ctx.reply('Введите /book для начала бронирования.');
    }

    ctx.session.step = BOOKING_STEPS.SELECT_ROW;

    const rows = await getRows(sectionName);
    const rowButtons = rows.map((row) =>
        Markup.button.callback(`Ряд ${row.row_number}`, `row_${sectionName}_${row.row_number}`)
    );
    rowButtons.push(Markup.button.callback('Назад', 'back_to_section'));
    rowButtons.push(Markup.button.callback('Отмена', 'cancel_booking'));

    const selectedSeatsString = getSelectedSeatsString(ctx);
    ctx.editMessageText(`Для подтверждения брони введите /confirm\nВыбранные места:\n${selectedSeatsString}\n\nТеущий выбор:\nСекция ${sectionName}\nВыберите ряд:`, Markup.inlineKeyboard(rowButtons, { columns: 3 }));
});

// Подтверждение брони
bot.command('confirm', async (ctx) => {
    if (!ctx.session?.selectedSeats || ctx.session.selectedSeats.length === 0) {
        ctx.reply('Вы не выбрали места для бронирования. Введите /book для выбора мест.');
        return;
    }

    ctx.reply('Введите ваше ФИО и номер телефона в формате: ФИО, Телефон');
    ctx.session.step = 'awaiting_user_info';
});

// Обработчик команды /mybookings
bot.command('mybookings', async (ctx) => {
    const client = await pool.connect();
    try {
        const { rows: bookings } = await client.query(
            `SELECT sections.name AS section_name, rows.row_number, seats.seat_number
       FROM seats
       JOIN rows ON rows.id = seats.row_id
       JOIN sections ON sections.id = rows.section_id
       WHERE seats.booked_by = (SELECT id FROM users WHERE telegram_id = $1);
      `,
            [ctx.from?.id]
        );

        if (bookings.length === 0) {
            ctx.reply('У вас нет активных броней.');
            return;
        }

        const message = bookings
            .map((b) => `Секция: ${b.section_name}, Ряд: ${b.row_number}, Место: ${b.seat_number}`)
            .join('\n');

        ctx.reply(`Ваши брони:\n${message}\nДля отмены брони введите /cancel.`);
    } catch (error) {
        console.error('Error fetching bookings:', error);
        ctx.reply('Произошла ошибка при получении ваших броней. Попробуйте позже.');
    } finally {
        client.release();
    }
});

// Обработчик команды /cancel
bot.command('cancel', async (ctx) => {
    const client = await pool.connect();
    try {
        const { rows: bookings } = await client.query(
            `SELECT sections.name AS section_name, rows.row_number, seats.seat_number
         FROM seats
         JOIN rows ON rows.id = seats.row_id
         JOIN sections ON sections.id = rows.section_id
         WHERE seats.booked_by = (SELECT id FROM users WHERE telegram_id = $1);
        `,
            [ctx.from?.id]
        );

        if (bookings.length === 0) {
            ctx.reply('У вас нет активных броней.');
            return;
        }

        const sections: Record<string, Record<number, number[]>> = {};
        for (const booking of bookings) {
            if (!sections[booking.section_name]) sections[booking.section_name] = {};
            if (!sections[booking.section_name][booking.row_number]) sections[booking.section_name][booking.row_number] = [];
            sections[booking.section_name][booking.row_number].push(booking.seat_number);
        }

        for (const section in sections) {
            await ctx.reply(`Секция: ${section} (Выберите место для отмены)`);
            for (const row in sections[section]) {
                const buttons = sections[section][row].map((seat) =>
                    Markup.button.callback(
                        `${seat}`,
                        `cancel_${section}_${row}_${seat}` // Use a different prefix for cancel callbacks
                    )
                );
                await ctx.reply(`Ряд ${row}:`, {
                    reply_markup: Markup.inlineKeyboard(buttons, { columns: 3 }).reply_markup,
                });
            }
        }

    } catch (error) {
        console.error('Error fetching bookings for cancellation:', error);
        ctx.reply('Произошла ошибка при получении ваших броней. Попробуйте позже.');
    } finally {
        client.release();
    }
});




// Обработчик выбора места
bot.on('callback_query', async (ctx) => {
    const callbackQuery = ctx.callbackQuery;
    const data = 'data' in callbackQuery ? callbackQuery.data : null;
    if (data?.startsWith('select_')) {
        const [, section, row, seat] = data.split('_');
        const seatInfo = { section, row: parseInt(row), seat: parseInt(seat) };

        ctx.session = ctx.session || { selectedSeats: [] };

        if (!ctx.session.selectedSeats) ctx.session.selectedSeats = [];

        if (
            ctx.session.selectedSeats.some(
                (s) => s.section === section && s.row === parseInt(row) && s.seat === parseInt(seat)
            )
        ) {
            ctx.reply(`Место ${seat} в ряду ${row} уже выбрано.`);
        } else {
            ctx.session.selectedSeats.push(seatInfo);
            ctx.reply(`Место ${seat} в ряду ${row} добавлено в вашу бронь.`);
        }

        await ctx.answerCbQuery();
    }
    else if (data?.startsWith('cancel_')) {  // Handle cancellation callbacks
        const [, section, row, seat] = data.split('_');
        const client = await pool.connect();

        try {
            const { rowCount } = await client.query(
                `UPDATE seats SET is_booked = FALSE, booked_by = NULL
             FROM rows, sections
             WHERE seats.row_id = rows.id
             AND rows.section_id = sections.id
             AND sections.name = $1
             AND rows.row_number = $2
             AND seats.seat_number = $3
             AND seats.booked_by = (SELECT id FROM users WHERE telegram_id = $4);`,
                [section, row, seat, ctx.from?.id]
            );

            if (rowCount === 0) {
                ctx.reply('Место не найдено или не забронировано вами.');
            } else {
                ctx.reply('Бронь успешно отменена.');
            }
        } catch (error) {
            console.error('Error cancelling booking:', error);
            ctx.reply('Произошла ошибка при отмене брони. Попробуйте снова.');
        } finally {
            client.release();
            await ctx.answerCbQuery(); // Answer the callback query
        }
    }
});



bot.on('text', async (ctx) => {
    const client = await pool.connect();
    try {
        if (ctx.session?.step === 'awaiting_user_info') {
            const input = ctx.message.text.trim();
            const [fullName, phoneNumber] = input.split(',').map((s) => s.trim());

            if (!fullName || !phoneNumber) {
                ctx.reply('Некорректный формат. Введите данные в формате: ФИО, Телефон');
                return;
            }

            const { rows: userRows } = await client.query(
                `INSERT INTO users (full_name, phone_number, telegram_id) 
         VALUES ($1, $2, $3) 
         ON CONFLICT (telegram_id) DO UPDATE SET full_name = EXCLUDED.full_name, phone_number = EXCLUDED.phone_number
         RETURNING id;`,
                [fullName, phoneNumber, ctx.from?.id]
            );

            const userId = userRows[0].id;

            for (const seat of ctx.session.selectedSeats || []) {
                const { rows: seatCheck } = await client.query(
                    `SELECT is_booked FROM seats 
                     JOIN rows ON seats.row_id = rows.id
                     JOIN sections ON rows.section_id = sections.id
                     WHERE sections.name = $1
                     AND rows.row_number = $2
                     AND seats.seat_number = $3
                     AND is_booked = FALSE;`, // Проверяем, что место все еще свободно
                    [seat.section, seat.row, seat.seat]
                );

                if (seatCheck.length === 0) {  // Место уже забронировано кем-то другим
                    ctx.reply(`Место ${seat.seat} в секции ${seat.section}, ряд ${seat.row} уже забронировано. Пожалуйста, выберите другое место.`);
                    return; // Прерываем бронирование
                }
            }

            for (const seat of ctx.session.selectedSeats || []) {
                await client.query(
                    `UPDATE seats SET is_booked = TRUE, booked_by = $1
           FROM rows, sections
           WHERE seats.row_id = rows.id
           AND rows.section_id = sections.id
           AND sections.name = $2
           AND rows.row_number = $3
           AND seats.seat_number = $4;`,
                    [userId, seat.section, seat.row, seat.seat]
                );
            }

            ctx.reply('Бронь успешно подтверждена. Спасибо!\nИспользуйте /mybookings для просмотра броней.');
            ctx.session = {};
        }
        else {
            ctx.reply('Используйте команду /book для начала бронирования или /mybookings для просмотра броней.');
        }
    } catch (error) {
        console.error('Error processing cancellation:', error);
        ctx.reply('Произошла ошибка при отмене брони. Попробуйте снова.');
    } finally {
        client.release();
    }
});

// Запуск бота
bot.launch();

// Обработка завершения работы
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
