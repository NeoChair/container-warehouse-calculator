import sql from 'mssql'

const config: sql.config = {
    server: process.env.DB_SERVER!,
    port: Number(process.env.DB_PORT) || 1433,
    database: process.env.DB_NAME!,
    user: process.env.DB_USER!,
    password: process.env.DB_PASSWORD!,
    options: {
        trustServerCertificate: true,
        encrypt: false,
    }
}

let pool: sql.ConnectionPool | null = null

export async function getDb() {
    if (!pool) {
        pool = await sql.connect(config)
    }
    return pool
}