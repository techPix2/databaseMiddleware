require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();

app.use(cors());

app.use(bodyParser.json());

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

app.use(async (req, res, next) => {
    try {
        const connection = await pool.getConnection();
        connection.release();
        next();
    } catch (err) {
        console.error('Erro na conexão com o banco:', err);
        res.status(503).json({ error: 'Service Unavailable - Database connection failed' });
    }
});

app.get('/api/status', (req, res) => {
    res.json({
        status: 'online',
        environment: process.env.NODE_ENV || 'development',
        dbHost: process.env.DB_HOST
    });
});

app.post('/api/login', async (req, res) => {
    const { name, password } = req.body;

    if (!name || !password) {
        return res.status(400).json({ error: 'Nome e senha são obrigatórios' });
    }

    try {
        const [rows] = await pool.query(
            "SELECT idEmployer, fkCompany FROM Employer WHERE name = ? AND password = ?",
            [name, password]
        );

        if (rows.length > 0) {
            const companyName = await getCompanyName(rows[0].fkCompany);
            res.json({
                success: true,
                company_id: rows[0].fkCompany,
                company_name: companyName
            });
        } else {
            res.status(401).json({ success: false, message: "Credenciais inválidas" });
        }
    } catch (error) {
        console.error("Erro no login:", error);
        res.status(500).json({ error: 'Erro interno no servidor' });
    }
});

app.route('/api/machines')
    .post(async (req, res) => {
        const { hostname, macAddress, mobuId, fkCompany } = req.body;

        if (!hostname || !macAddress || !mobuId || !fkCompany) {
            return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
        }

        try {
            const [existing] = await pool.query(
                "SELECT idServer FROM Server WHERE mobuId = ? AND fkCompany = ?",
                [mobuId, fkCompany]
            );

            if (existing.length > 0) {
                return res.json({
                    success: true,
                    machine_id: existing[0].idServer,
                    message: "Máquina já cadastrada"
                });
            }

            const [result] = await pool.query(
                `INSERT INTO Server
                     (hostname, macAddress, mobuId, fkCompany, status)
                 VALUES (?, ?, ?, ?, 'active')`,
                [hostname, macAddress, mobuId, fkCompany]
            );

            res.json({
                success: true,
                machine_id: result.insertId,
                message: "Máquina cadastrada com sucesso!"
            });
        } catch (error) {
            console.error("Erro ao cadastrar máquina:", error);
            res.status(500).json({ error: 'Erro ao cadastrar máquina' });
        }
    })
    .get(async (req, res) => {
        const { mobuId, fkCompany } = req.query;

        try {
            const [rows] = await pool.query(
                "SELECT idServer FROM Server WHERE mobuId = ? AND fkCompany = ?",
                [mobuId, fkCompany]
            );

            res.json({ exists: rows.length > 0, machine: rows[0] });
        } catch (error) {
            console.error("Erro ao buscar máquina:", error);
            res.status(500).json({ error: 'Erro ao buscar máquina' });
        }
    });

app.post('/api/components/sync', async (req, res) => {
    const { fkServer, fkCompany, components } = req.body;

    if (!fkServer || !fkCompany || !components) {
        return res.status(400).json({ error: 'Parâmetros obrigatórios faltando' });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [dbComponents] = await connection.query(
            `SELECT idComponent, name, type, description 
             FROM Component 
             WHERE fkServer = ?`,
            [fkServer]
        );

        const currentNames = components.map(c => c.name);
        const dbNameMap = {};

        dbComponents.forEach(comp => {
            dbNameMap[comp.name] = comp;
        });

        for (const dbComp of dbComponents) {
            if (!currentNames.includes(dbComp.name)) {
                await connection.query(
                    `UPDATE Component SET active = 0 
                     WHERE idComponent = ? AND fkServer = ?`,
                    [dbComp.idComponent, fkServer]
                );
                console.log(`[DESATIVADO] Componente: ${dbComp.name}`);
            }
        }

        for (const currentComp of components) {
            const currentDesc = currentComp.description ? String(currentComp.description) : null;

            if (currentComp.name in dbNameMap) {
                const dbComp = dbNameMap[currentComp.name];
                const needsUpdate = (
                    dbComp.type !== currentComp.type ||
                    String(dbComp.description) !== currentDesc
                );

                if (needsUpdate) {
                    await connection.query(
                        `UPDATE Component 
                         SET type = ?, description = ?, active = 1 
                         WHERE idComponent = ? AND fkServer = ?`,
                        [currentComp.type, currentDesc, dbComp.idComponent, fkServer]
                    );
                    console.log(`[ATUALIZADO] Componente: ${currentComp.name}`);
                }
            } else {
                await connection.query(
                    `INSERT INTO Component 
                     (name, type, description, fkServer, active) 
                     VALUES (?, ?, ?, ?, 1)`,
                    [currentComp.name, currentComp.type, currentDesc, fkServer]
                );
                console.log(`[INSERIDO] Novo componente: ${currentComp.name}`);
            }
        }

        await connection.commit();
        res.json({
            success: true,
            message: `✅ Sincronização concluída para servidor ${fkServer} (Empresa ${fkCompany})`
        });
    } catch (error) {
        await connection.rollback();
        console.error('❌ Erro na sincronização:', error);
        res.status(500).json({
            success: false,
            message: '❌ Erro durante a sincronização',
            error: error.message
        });
    } finally {
        connection.release();
    }
});

app.get('/api/system/info', async (req, res) => {
    try {
        const os = require('os');
        const systemInfo = {
            platform: os.platform(),
            hostname: os.hostname(),
            cpu: os.cpus()[0].model,
            totalMemory: os.totalmem(),
            freeMemory: os.freemem(),
            networkInterfaces: os.networkInterfaces()
        };
        res.json(systemInfo);
    } catch (error) {
        console.error("Erro ao obter informações do sistema:", error);
        res.status(500).json({ error: 'Erro ao obter informações do sistema' });
    }
});

async function getCompanyName(companyId) {
    try {
        const [rows] = await pool.query(
            "SELECT socialReason FROM Company WHERE idCompany = ?",
            [companyId]
        );
        return rows.length > 0 ? rows[0].socialReason : "TechPix";
    } catch (error) {
        console.error("Erro ao buscar nome da empresa:", error);
        return "TechPix";
    }
}

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Erro interno no servidor' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`Ambiente: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Conectado ao banco: ${process.env.DB_HOST}`);
});