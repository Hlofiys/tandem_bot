import { Pool } from 'pg';

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'bot',  // Your database name
  password: 'postgres', // Your password
  port: 5432,
});

async function populateDatabase() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); // Start transaction

    // Insert Section (assuming only one section: "Партер" for now. Adjust if needed)
    const sectionResult = await client.query(
      "INSERT INTO sections (name) VALUES ('Партер') RETURNING id;"
    );
    const sectionId = sectionResult.rows[0].id;
    const БалконSectionResult = await client.query(
      "INSERT INTO sections (name) VALUES ('Балкон') RETURNING id;"
    );
    const БалконSectionId = БалконSectionResult.rows[0].id;



    const seatData = [
      { section: 'Партер', rows: 18, seatsPerRow: 28 },
      { section: 'Балкон', rows: 8, seatsPerRow: 23 }
    ];



    for (const sd of seatData) {
      let currentSectionId = 0;
      if (sd.section === 'Партер') {
        currentSectionId = sectionId;
      } else if (sd.section === 'Балкон') {
        currentSectionId = БалконSectionId;
      }
      for (let rowNumber = 1; rowNumber <= sd.rows; rowNumber++) {
        const rowResult = await client.query(
          'INSERT INTO rows (section_id, row_number) VALUES ($1, $2) RETURNING id;',
          [currentSectionId, rowNumber]
        );
        const rowId = rowResult.rows[0].id;

        for (let seatNumber = 1; seatNumber <= sd.seatsPerRow; seatNumber++) {

          let isBooked = false;
          let bookedBy = null;

          // Check for specific booked seats (customize as needed)
          if (sd.section === 'Партер') {

            if (rowNumber === 3 && (seatNumber === 2 || seatNumber === 3)) {
              isBooked = true;
            } else if (rowNumber === 14 && seatNumber >= 12 && seatNumber <= 16) {
              isBooked = true;
              // bookedBy = ... // Add user ID for "Пульт" if applicable.
            } else if (rowNumber === 17 && seatNumber <= 2) {
              isBooked = true;
            }


          }

          try {

            await client.query(
              'INSERT INTO seats (row_id, seat_number, is_booked, booked_by) VALUES ($1, $2, $3, $4);',
              [rowId, seatNumber, isBooked, bookedBy]
            );


          } catch (error) {

            console.error(`Error populating seats, section:${sd.section}, row:${rowNumber}, seat:${seatNumber}`, error);

          }

        }



      }
    }


    await client.query('COMMIT'); // Commit transaction
    console.log('Database populated successfully!');
  } catch (error) {
    await client.query('ROLLBACK'); // Rollback on error
    console.error('Error populating database:', error);
  } finally {
    client.release();
  }
}

populateDatabase();