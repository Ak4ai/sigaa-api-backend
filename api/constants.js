// constants.js
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const daysMap = {
  '2': 'Segunda-feira',
  '3': 'Terça-feira',
  '4': 'Quarta-feira',
  '5': 'Quinta-feira',
  '6': 'Sexta-feira',
  '7': 'Sábado'
};

const timeSlots = {
  M: {
    '1': '07:00-07:50',
    '2': '07:50-08:40',
    '3': '08:55-09:45',
    '4': '09:45-10:35',
    '5': '10:50-11:40',
    '6': '11:40-12:30'
  },
  T: {
    '1': '13:50-14:40',
    '2': '14:40-15:30',
    '3': '15:50-16:40',
    '4': '16:40-17:30',
    '5': '17:30-18:20'
  },
  N: {
    '1': '19:00-19:50',
    '2': '19:50-20:40',
    '3': '20:55-21:45',
    '4': '21:45-22:35'
  }
};

module.exports = { delay, daysMap, timeSlots };
