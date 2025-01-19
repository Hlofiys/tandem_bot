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
    fullName?: string;
    phoneNumber?: string;
}

interface TgContext extends Context {
    session?: SessionData;
}

var token = process.env.BOT_TOKEN;
if (token == undefined) {
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

      CREATE INDEX IF NOT EXISTS users_telegram_id ON users (telegram_id);
    `);
    } catch (error) {
        console.error('Error creating tables:', error);
    } finally {
        client.release();
    }
})();

// Обработчик команды /start
bot.start(async (ctx) => {
    ctx.reply('Добро пожаловать в в систему бронирования мест на ЗОК 2025 в 12:30. Введите /book для начала бронирования.');
});

// Обработчик команды /book
const BOOKING_STEPS = {
    SELECT_SECTION: 'select_section',
    SELECT_ROW: 'select_row',
    SELECT_SEAT: 'select_seat',
    CONFIRM: 'confirm',
    AWAITING_FULL_NAME: 'awaiting_full_name',
    AWAITING_PHONE_NUMBER: 'awaiting_phone_number',
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


bot.action(/^cancel_section_(.+)/, async (ctx) => {
    const sectionName = ctx.match[1];
    if (ctx.session == undefined) {
        return;
    }
    ctx.session.selectedSection = sectionName;
    // Get cancellable rows for this user in this section
    const rows = await getCancellableRows(sectionName, ctx);
    const sectionButtons = rows.map((row) =>
        Markup.button.callback(`Ряд ${row.row_number}`, `cancel_row_${sectionName}_${row.row_number}`)
    );
    sectionButtons.push(Markup.button.callback('Отмена', 'cancel_booking'));

    ctx.editMessageText(`Выберите ряд для отмены (Секция ${sectionName}):`, Markup.inlineKeyboard(sectionButtons, { columns: 3 }));
});

bot.action(/^cancel_row_(.+)_(.+)/, async (ctx) => {
    const sectionName = ctx.match[1];
    const rowNumber = parseInt(ctx.match[2], 10);
    if (ctx.session == undefined) {
        return;
    }
    ctx.session.selectedRow = rowNumber;


    const seats = await getCancellableSeats(sectionName, rowNumber, ctx);

    const selectedSeats = ctx.session?.selectedSeats || [];

    const rowButtons = seats.map((seat) => {
        let label = `Место ${seat.seat_number}`;
        if (selectedSeats.some(s => s.section === sectionName && s.row === rowNumber && s.seat === seat.seat_number)) {
            label += " ✅"; // Mark selected seats
        }
        return Markup.button.callback(label, `cancel_seat_${sectionName}_${rowNumber}_${seat.seat_number}`);
    });

    rowButtons.push(Markup.button.callback('Назад', `cancel_back_to_row_${sectionName}`));
    if (selectedSeats.length > 0) {
        rowButtons.push(Markup.button.callback('Подтвердить отмену', 'confirm_cancellation'));
    }    
    rowButtons.push(Markup.button.callback('Отмена', 'cancel_booking'));

    ctx.editMessageText(`Выберите места для отмены (Секция ${sectionName}, Ряд ${rowNumber}):`, Markup.inlineKeyboard(rowButtons, { columns: 3 }));
});


bot.action(/cancel_seat_(.+)_(.+)_(.+)/, async (ctx) => {
    const [sectionName, rowNumberStr, seatNumberStr] = ctx.match.slice(1);
    const rowNumber = parseInt(rowNumberStr, 10);
    const seatNumber = parseInt(seatNumberStr, 10);

    if(ctx.session == undefined)
    {
        return;
    }

    ctx.session.selectedSeats = ctx.session.selectedSeats || [];

    const seatInfo = { section: sectionName, row: rowNumber, seat: seatNumber };

    const existingSeatIndex = ctx.session.selectedSeats.findIndex(
        (s) => s.section === sectionName && s.row === rowNumber && s.seat === seatNumber
    );

    if (existingSeatIndex > -1) {
        ctx.session.selectedSeats.splice(existingSeatIndex, 1); // Remove if already selected
        ctx.answerCbQuery(`Место ${seatNumber} снято с отмены.`);
    } else {
        ctx.session.selectedSeats.push(seatInfo); // Add to selected seats
        ctx.answerCbQuery(`Место ${seatNumber} добавлено к отмене.`);
    }

     // Re-render the seats buttons with updated selection
     const seats = await getCancellableSeats(sectionName, rowNumber, ctx);
     const selectedSeats = ctx.session?.selectedSeats || [];

    const rowButtons = seats.map((seat) => {
        let label = `Место ${seat.seat_number}`;
        if (selectedSeats.some(s => s.section === sectionName && s.row === rowNumber && s.seat === seat.seat_number)) {
            label += " ✅"; // Mark selected seats
        }
        return Markup.button.callback(label, `cancel_seat_${sectionName}_${rowNumber}_${seat.seat_number}`);
    });

    rowButtons.push(Markup.button.callback('Назад', `cancel_back_to_row_${sectionName}`));
    if (selectedSeats.length > 0) {
        rowButtons.push(Markup.button.callback('Подтвердить отмену', 'confirm_cancellation'));
    }
    rowButtons.push(Markup.button.callback('Отмена', 'cancel_booking'));

    ctx.editMessageText(`Выберите места для отмены (Секция ${sectionName}, Ряд ${rowNumber}):`, Markup.inlineKeyboard(rowButtons, { columns: 3 }));

});

bot.action('confirm_cancellation', async (ctx) => {
    if (!ctx.session || !ctx.session.selectedSeats || ctx.session.selectedSeats.length === 0) {
        return ctx.reply('Вы не выбрали места для отмены.');
    }

    await ctx.deleteMessage();

    const client = await pool.connect();
    try {
        const userId = (await client.query(`SELECT id FROM users WHERE telegram_id = $1`, [ctx.from?.id]))?.rows?.[0]?.id;


        for (const seat of ctx.session.selectedSeats) {
            const { rowCount } = await client.query(
                `UPDATE seats SET is_booked = FALSE, booked_by = NULL
                 WHERE row_id = (SELECT id FROM rows WHERE section_id = (SELECT id FROM sections WHERE name = $1) AND row_number = $2)
                 AND seat_number = $3 AND booked_by = $4;`,
                [seat.section, seat.row, seat.seat, userId]
            );

             if (rowCount !== 1) {
                // Handle cases where a seat couldn't be cancelled (e.g., already cancelled by someone else)
                ctx.reply(`Место ${seat.seat} в секции ${seat.section}, ряд ${seat.row} не найдено или не забронировано вами.`);
                return; // Stop the loop and the cancellation process
            }
        }


        ctx.reply(`${ctx.session.selectedSeats.length} мест(а) успешно отменено.`);
        ctx.session.step = undefined; // Clear the session after cancellation
        ctx.session.selectedSeats = []; // Clear selected seats

    } catch (error) {
        console.error('Error during seat cancellation:', error);
        ctx.reply('Произошла ошибка при отмене бронирования.');
    } finally {
        client.release();
        await ctx.answerCbQuery();

    }
});

// Action handler for 'back' button during cancellation
bot.action(/^cancel_back_to_row_(.+)/, async (ctx) => {
    const sectionName = ctx.match[1];
    if (ctx.session) {
        ctx.session.selectedRow = undefined; // Reset selected row in session
        const rows = await getCancellableRows(sectionName, ctx);
        const rowButtons = rows.map((row) =>
            Markup.button.callback(`Ряд ${row.row_number}`, `cancel_row_${sectionName}_${row.row_number}`)
        );


        rowButtons.push(Markup.button.callback('Отмена', 'cancel_booking'));
        ctx.editMessageText(`Выберите ряд для отмены (Секция ${sectionName}):`, Markup.inlineKeyboard(rowButtons, { columns: 3 }));
    }
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
        Markup.button.callback(`Ряд ${row.row_number} (${row.free_seats}/${row.total_seats})`, `row_${sectionName}_${row.row_number}`)
    );
    sectionButtons.push(Markup.button.callback('Назад', 'back_to_section'));
    sectionButtons.push(Markup.button.callback('Отмена', 'cancel_booking')); // Add cancel button

    const selectedSeatsString = getSelectedSeatsString(ctx);
    return ctx.editMessageText(`Выбранные места:\n${selectedSeatsString}\n\nТекущий выбор:\nCекция ${sectionName}\nВыберите ряд:`, Markup.inlineKeyboard(sectionButtons, { columns: 3 }));
});

bot.action(/row_(.+)_(.+)/, async (ctx) => {
    const sectionName = (ctx.match[1]);
    const rowNumber = (ctx.match[2]);
    if (ctx.session == undefined) {
        return ctx.reply('Введите /book для начала бронирования.');
    }
    ctx.session.selectedRow = parseInt(rowNumber, 10);
    ctx.session.step = BOOKING_STEPS.SELECT_SEAT;
    const seats = await getSeats(sectionName, parseInt(rowNumber, 10), ctx);
    const rowButtons = seats.map((seat) => { // Use seats with isBookedByUser
        let label = `Место ${seat.seat_number}`;
        if (seat.isSelected) {
            label += " ✅";
        } else if (seat.isBookedByUser) {
            label += " 👤";
        }
        return Markup.button.callback(label, `seat_${sectionName}_${parseInt(rowNumber, 10)}_${seat.seat_number}`);
    });
    rowButtons.push(Markup.button.callback('Назад', `back_to_row_${sectionName}`));
    rowButtons.push(Markup.button.callback('Отмена', 'cancel_booking')); // Add cancel button
    if (ctx.session.selectedSeats != undefined && ctx.session.selectedSeats.length! > 0) {
        rowButtons.push(Markup.button.callback('Подтвердить', 'confirm_booking'));
    }

    const selectedSeatsString = getSelectedSeatsString(ctx);
    ctx.editMessageText(`Выбранные места:\n${selectedSeatsString}\n\nТекущий выбор:\nCекция ${sectionName}, Ряд ${rowNumber}\nВыберите место:`, Markup.inlineKeyboard(rowButtons, { columns: 3 }));
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

    const existingSeatIndex = ctx.session.selectedSeats.findIndex(
        (s) => s.section === seatInfo.section && s.row === seatInfo.row && s.seat === seatInfo.seat
    );

    var seats = await getSeats(sectionName, parseInt(rowNumber, 10), ctx);
    const selectedSeat = seats.find(seat => seat.seat_number === parseInt(seatNumber)); // Находим selectedSeat

    if (existingSeatIndex > -1) {
        ctx.session.selectedSeats.splice(existingSeatIndex, 1);
        ctx.answerCbQuery(`Место ${seatNumber} снято с брони.`);
    } else if (!selectedSeat?.isBookedByUser) { // Проверка на undefined и isBookedByUser
        ctx.session.selectedSeats.push(seatInfo);
        ctx.answerCbQuery(`Место ${seatNumber} добавлено к брони.`);
    } else {
        ctx.answerCbQuery('Это место уже забронировано вами.');
        return;
    }

    seats = await getSeats(sectionName, parseInt(rowNumber, 10), ctx);

    const seatButtons = seats.map((seat) => {
        let label = `Место ${seat.seat_number}`;
        if (seat.isSelected) {
            label += ' ✅';
        } else if (seat.isBookedByUser) {
            label += ' 👤';
        }
        return Markup.button.callback(label, `seat_${sectionName}_${parseInt(rowNumber, 10)}_${seat.seat_number}`);
    });

    seatButtons.push(Markup.button.callback('Назад', `back_to_row_${sectionName}`));
    seatButtons.push(Markup.button.callback('Отмена', 'cancel_booking'));
    if (ctx.session.selectedSeats.length > 0) {
        seatButtons.push(Markup.button.callback('Подтвердить', 'confirm_booking'));
    }

    const selectedSeatsString = getSelectedSeatsString(ctx);

    try {
        //  Объединяем обновление текста и кнопок в один вызов editMessageText
        await ctx.editMessageText(
            `Выбранные места:\n${selectedSeatsString}\n\nТекущий выбор:\nСекция ${sectionName}, Ряд ${rowNumber}\nВыберите место:`,
            Markup.inlineKeyboard(seatButtons, { columns: 3 })
        );
    } catch (error) {
        console.error("Error updating message:", error);
        ctx.reply("Произошла ошибка при обновлении сообщения. Попробуйте еще раз.");
    }
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
            `SELECT rows.row_number, COUNT(seats.id) AS total_seats,
             (SELECT COUNT(s.id) FROM seats s JOIN rows r ON s.row_id = r.id JOIN sections sec ON r.section_id = sec.id WHERE sec.name = $1 AND r.row_number = rows.row_number AND s.is_booked = FALSE) AS free_seats
             FROM rows
             JOIN sections ON rows.section_id = sections.id
             LEFT JOIN seats ON rows.id = seats.row_id
             WHERE sections.name = $1
             GROUP BY rows.row_number
             ORDER BY rows.row_number ASC`, // Add ORDER BY clause here
            [sectionName]
        );
        return rows;
    } finally {
        client.release();
    }
}


async function getSeats(sectionName: string, rowNumber: number, ctx: TgContext) {
    const client = await pool.connect();
    try {
        const { rows } = await client.query(
            `SELECT seats.seat_number, seats.booked_by
             FROM seats
             JOIN rows ON seats.row_id = rows.id
             JOIN sections ON rows.section_id = sections.id
             WHERE sections.name = $1
             AND rows.row_number = $2
             ORDER BY seats.seat_number;`, // ORDER BY для упорядочивания
            [sectionName, rowNumber]
        );

        const selectedSeats = ctx.session?.selectedSeats || [];
        const userId = (await client.query(`SELECT id FROM users WHERE telegram_id = $1`, [ctx.from?.id]))?.rows?.[0]?.id;

        const seatsWithSelection = rows.map(seat => ({
            ...seat,
            isSelected: selectedSeats.some(s => s.section === sectionName && s.row === rowNumber && s.seat === seat.seat_number),
            isBookedByUser: seat.booked_by === userId
        }));

        return seatsWithSelection;
    } finally {
        client.release();
    }
}

function getSelectedSeatsString(ctx: TgContext) {
    return ctx.session && ctx.session.selectedSeats ? ctx.session.selectedSeats.map(s => `Секция ${s.section}, Ряд ${s.row}, Место ${s.seat}`).join('\n') : "";
}

// Обработчик кнопок "Подтвердить"
bot.action('confirm_booking', async (ctx) => {
    if (!ctx.session?.selectedSeats || ctx.session.selectedSeats.length === 0) {
        ctx.reply('Вы не выбрали места для бронирования. Введите /book для выбора мест.');
        return;
    }

    // Удаляем предыдущее сообщение с кнопками
    await ctx.deleteMessage();

    ctx.reply('Введите ваше ФИО:');
    ctx.session.step = BOOKING_STEPS.AWAITING_FULL_NAME;
});


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
    return ctx.editMessageText(`Выбранные места:\n${selectedSeatsString}\nВыберите секцию:`, Markup.inlineKeyboard(sectionButtons, { columns: 2 }));

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
        Markup.button.callback(`Ряд ${row.row_number} (${row.free_seats}/${row.total_seats})`, `row_${sectionName}_${row.row_number}`)
    );
    rowButtons.push(Markup.button.callback('Назад', 'back_to_section'));
    rowButtons.push(Markup.button.callback('Отмена', 'cancel_booking'));

    const selectedSeatsString = getSelectedSeatsString(ctx);
    ctx.editMessageText(`Выбранные места:\n${selectedSeatsString}\n\nТеущий выбор:\nСекция ${sectionName}\nВыберите ряд:`, Markup.inlineKeyboard(rowButtons, { columns: 3 }));
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
        const userId = (await client.query(`SELECT id FROM users WHERE telegram_id = $1`, [ctx.from?.id]))?.rows?.[0]?.id;

        if (!userId) {
            ctx.reply('У вас нет активных броней.');
            return;
        }

        ctx.session = { selectedSeats: [], step: 'cancel_seat' }; // Initialize session for cancellation

        const sections = await getCancellableSections(userId); // Get sections with bookable seats by this user


        if (sections.length === 0) {
            ctx.reply('У вас нет активных броней.');
            delete ctx.session.step;  //Clear session if no bookings
            return;
        }

        const sectionButtons = sections.map((section) =>
            Markup.button.callback(section.name, `cancel_section_${section.name}`)
        );


        ctx.reply('Выберите секцию для отмены бронирования:', Markup.inlineKeyboard(sectionButtons, { columns: 2 }));


    } catch (error) {
        console.error('Error fetching bookings for cancellation:', error);
        ctx.reply('Произошла ошибка при получении ваших броней. Попробуйте позже.');
        if (ctx.session != undefined)
            delete ctx.session.step;  //Clear session in case of error
    } finally {
        client.release();
    }
});


async function getCancellableSections(userId: number) {
    const client = await pool.connect();
    try {
        const { rows } = await client.query(
            `SELECT DISTINCT sections.name
             FROM seats
             JOIN rows ON seats.row_id = rows.id
             JOIN sections ON rows.section_id = sections.id
             WHERE seats.booked_by = $1`,
            [userId]
        );
        return rows;
    } finally {
        client.release();
    }
}


async function getCancellableRows(sectionName: string, ctx: TgContext) {
    const client = await pool.connect();
    try {
        const userId = (await client.query(`SELECT id FROM users WHERE telegram_id = $1`, [ctx.from?.id]))?.rows?.[0]?.id;
        const { rows } = await client.query(
            `SELECT DISTINCT rows.row_number
             FROM seats
             JOIN rows ON seats.row_id = rows.id
             JOIN sections ON rows.section_id = sections.id
             WHERE sections.name = $1 AND seats.booked_by = $2`,
            [sectionName, userId]
        );
        return rows;
    } finally {
        client.release();
    }
}


async function getCancellableSeats(sectionName: string, rowNumber: number, ctx: TgContext) {
    const client = await pool.connect();
    try {

        const userId = (await client.query(`SELECT id FROM users WHERE telegram_id = $1`, [ctx.from?.id]))?.rows?.[0]?.id;
        const { rows } = await client.query(
            `SELECT seats.seat_number
             FROM seats
             JOIN rows ON seats.row_id = rows.id
             JOIN sections ON rows.section_id = sections.id
             WHERE sections.name = $1
             AND rows.row_number = $2 AND seats.booked_by = $3
             ORDER BY seats.seat_number;`,
            [sectionName, rowNumber, userId]
        );
        return rows;
    } finally {
        client.release();
    }
}


bot.on('text', async (ctx) => {
    const client = await pool.connect();
    try {
        if (ctx.session?.step === BOOKING_STEPS.AWAITING_FULL_NAME) {
            ctx.session.fullName = ctx.message.text.trim();

            // Валидация ФИО (минимум 2 слова)
            if (ctx.session.fullName.split(/\s+/).length < 2) {
                ctx.reply('Пожалуйста, введите Фамилию и Имя целиком');
                return;
            }

            ctx.reply('Введите ваш номер телефона с кодом оператора в формате +375291111111:');
            ctx.session.step = BOOKING_STEPS.AWAITING_PHONE_NUMBER;
        } else if (ctx.session?.step === BOOKING_STEPS.AWAITING_PHONE_NUMBER) {
            const phoneNumber = ctx.message.text.trim();
            // Валидация номера телефона (простой пример, можно использовать более сложные регулярные выражения)
            if (!/^\+?\d{12}$/.test(phoneNumber)) {
                ctx.reply('Пожалуйста, введите корректный номер телефона (например, +375291111111).');
                return;
            }

            ctx.session.phoneNumber = phoneNumber;

            const { rows: userRows } = await client.query(
                `INSERT INTO users (full_name, phone_number, telegram_id) 
         VALUES ($1, $2, $3) 
         ON CONFLICT (telegram_id) DO UPDATE SET full_name = EXCLUDED.full_name, phone_number = EXCLUDED.phone_number
         RETURNING id;`,
                [ctx.session.fullName, ctx.session.phoneNumber, ctx.from?.id]
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

            ctx.reply('Бронь успешно подтверждена. Спасибо!\nИспользуйте /mybookings для просмотра броней.\nИспользуйте /cancel для отмени брони\nИспользуйте /book для бронирования дополнительных мест');
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
