const puppeteer = require('puppeteer');
const fs = require('fs');

async function searchCompaniesInNovocherkassk() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  console.log('Начинаю поиск компаний в Новочеркасске...');
  
  const results = {
    timestamp: new Date().toISOString(),
    city: 'Новочеркасск',
    companies: []
  };

  try {
    const page = await browser.newPage();
    
    // Поиск компаний через справочник 2GIS
    console.log('Поиск через справочник 2GIS...');
    await page.goto('https://2gis.ru/novocherkassk/search/Производственные%20компании', { 
      waitUntil: 'networkidle2',
      timeout: 60000
    });
    
    // Получение списка компаний
    await page.waitForSelector('._1hf7139', { timeout: 30000 });
    
    const companiesFromDirectories = await page.evaluate(() => {
      const companies = [];
      const items = document.querySelectorAll('._1hf7139');
      
      for (let item of items) {
        try {
          const nameElement = item.querySelector('._1al8z71');
          const addressElement = item.querySelector('._12dsk8h');
          
          if (nameElement) {
            const name = nameElement.textContent.trim();
            const address = addressElement ? addressElement.textContent.trim() : '';
            
            companies.push({
              name,
              address,
              source: '2GIS',
              type: 'Производство', // Предположительный тип
              website: '',
              contacts: []
            });
          }
        } catch (e) {
          console.error('Ошибка при обработке элемента:', e);
        }
      }
      
      return companies;
    });
    
    if (companiesFromDirectories.length > 0) {
      results.companies = [...results.companies, ...companiesFromDirectories];
      console.log(`Найдено компаний через 2GIS: ${companiesFromDirectories.length}`);
    }
    
    // Дополнительный поиск через Яндекс
    console.log('Поиск через Яндекс...');
    await page.goto('https://yandex.ru/search/?text=крупные%20предприятия%20новочеркасск', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });
    
    const companiesFromSearch = await page.evaluate(() => {
      const companies = [];
      const results = document.querySelectorAll('.serp-item');
      
      for (let result of results) {
        try {
          const titleElement = result.querySelector('.OrganicTitle-Link');
          if (!titleElement) continue;
          
          const title = titleElement.textContent.trim();
          const url = titleElement.href;
          
          // Фильтруем только компании, исключаем новости, справочники и т.д.
          if (!title.includes('список') && 
              !title.includes('каталог') && 
              !title.includes('все компании')) {
            
            companies.push({
              name: title,
              website: url,
              source: 'Яндекс',
              type: 'Неизвестно', // Будет уточнено позже
              address: 'Новочеркасск', // Будет уточнено позже
              contacts: []
            });
          }
        } catch (e) {
          console.error('Ошибка при обработке результата поиска:', e);
        }
      }
      
      return companies;
    });
    
    // Фильтрация результатов, поиск только компаний
    const filteredCompanies = companiesFromSearch.filter(company => {
      const name = company.name.toLowerCase();
      
      // Исключаем общие результаты и агрегаторы
      const excludeTerms = ['каталог', 'справочник', 'список', 'портал', 'вакансии', 'новости'];
      if (excludeTerms.some(term => name.includes(term))) {
        return false;
      }
      
      // Ищем компании, которые могут нуждаться в логистике
      const includeTerms = ['завод', 'фабрика', 'производство', 'пром', 'торг', 'агро', 'электро', 
                           'машин', 'строй', 'метал', 'нпо', 'нефт', 'газ'];
      
      return includeTerms.some(term => name.includes(term));
    });
    
    if (filteredCompanies.length > 0) {
      results.companies = [...results.companies, ...filteredCompanies];
      console.log(`Найдено компаний через Яндекс: ${filteredCompanies.length}`);
    }
    
    // Удаление дубликатов
    const uniqueCompanies = [];
    const companyNames = new Set();
    
    for (const company of results.companies) {
      if (!companyNames.has(company.name)) {
        companyNames.add(company.name);
        uniqueCompanies.push(company);
      }
    }
    
    results.companies = uniqueCompanies;
    console.log(`Всего уникальных компаний: ${uniqueCompanies.length}`);
    
    // Сохраняем результаты
    fs.writeFileSync('/root/.openclaw/workspace/logistics_search/novocherkassk_companies.json', 
                    JSON.stringify(results, null, 2));
                    
    // Теперь нужно найти контакты для первых 3-5 компаний
    console.log('Поиск контактов для выбранных компаний...');
    
    // Выбираем первые 5 компаний или меньше, если их меньше
    const companiesToProcess = uniqueCompanies.slice(0, Math.min(5, uniqueCompanies.length));
    
    for (let i = 0; i < companiesToProcess.length; i++) {
      const company = companiesToProcess[i];
      console.log(`Поиск контактов для: ${company.name}`);
      
      // Поиск в Яндексе сайта компании, если он не известен
      if (!company.website || company.website.includes('yandex.ru')) {
        await page.goto(`https://yandex.ru/search/?text=${encodeURIComponent(company.name + ' Новочеркасск официальный сайт')}`, {
          waitUntil: 'networkidle2',
          timeout: 60000
        });
        
        const websiteUrl = await page.evaluate(() => {
          const firstLink = document.querySelector('.organic__url');
          if (firstLink) return firstLink.href;
          return null;
        });
        
        if (websiteUrl && !websiteUrl.includes('yandex.ru')) {
          company.website = websiteUrl;
          console.log(`Найден сайт: ${websiteUrl}`);
        }
      }
      
      // Если нашли сайт, ищем контакты
      if (company.website && !company.website.includes('yandex.ru')) {
        try {
          await page.goto(company.website, { 
            waitUntil: 'networkidle2', 
            timeout: 60000 
          });
          
          // Ищем ссылки на контакты
          const contactLinks = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a'));
            return links
              .filter(link => {
                const text = link.textContent.toLowerCase();
                return text.includes('контакт') || text.includes('contact') || 
                       text.includes('о нас') || text.includes('about') ||
                       text.includes('компания');
              })
              .map(link => link.href);
          });
          
          // Переходим на страницу контактов, если нашли
          if (contactLinks.length > 0) {
            await page.goto(contactLinks[0], { 
              waitUntil: 'networkidle2',
              timeout: 30000 
            });
            
            // Извлекаем информацию о контактах
            const contactInfo = await page.evaluate(() => {
              // Поиск email
              const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/gi;
              const pageText = document.body.innerText;
              const emails = pageText.match(emailRegex) || [];
              
              // Поиск телефонов
              const phoneRegex = /(\+7|8)[- .]?(\(?\d{3}\)?)[- .]?(\d{3})[- .]?(\d{2})[- .]?(\d{2})/g;
              const phones = pageText.match(phoneRegex) || [];
              
              return { emails, phones };
            });
            
            company.contacts = [
              ...contactInfo.emails.map(email => ({ type: 'email', value: email })),
              ...contactInfo.phones.map(phone => ({ type: 'phone', value: phone }))
            ];
            
            console.log(`Найдено контактов: ${company.contacts.length}`);
          } else {
            console.log(`Не найдена страница контактов для ${company.name}`);
          }
          
        } catch (e) {
          console.error(`Ошибка при обработке сайта ${company.website}:`, e.message);
        }
      }
      
      // Пауза между запросами, чтобы избежать блокировки
      await new Promise(r => setTimeout(r, 3000));
    }
    
    // Обновляем результаты с найденными контактами
    fs.writeFileSync('/root/.openclaw/workspace/logistics_search/novocherkassk_companies.json', 
                    JSON.stringify(results, null, 2));
                    
    console.log('Поиск завершен, результаты сохранены.');
    return results;
  } catch (error) {
    console.error('Произошла ошибка:', error);
    return { error: error.message };
  } finally {
    await browser.close();
  }
}

// Запускаем поиск
searchCompaniesInNovocherkassk();